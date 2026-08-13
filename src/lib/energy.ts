// PROMPT 21 — Energia: ERP-style invoice workflow + meter analytics.

export function validateEnergyInvoice(env: any, invoiceId: number) {
  const row = env.sql.query<any>(
    `SELECT i.*, c.price_per_kwh, c.fixed_monthly_grosze, c.ppe, c.tariff
       FROM energy_invoices i JOIN energy_contracts c ON c.id=i.contract_id WHERE i.id=?`, [invoiceId]
  )[0];
  if (!row) return { error: "invoice_not_found" };
  const expectedNet = Math.round(Number(row.consumption_kwh) * Number(row.price_per_kwh) * 100) + Number(row.fixed_monthly_grosze || 0);
  const tariffVariancePct = expectedNet ? Math.round(((Number(row.net_grosze) - expectedNet) / expectedNet) * 10000) / 100 : 0;
  const measured = env.sql.query<{ kwh: number | null }>(
    `SELECT SUM(r.interval_kwh) kwh FROM energy_readings r JOIN energy_meters m ON m.id=r.meter_id
      WHERE m.contract_id=? AND r.read_at>=? AND r.read_at<=? AND r.quality_status IN ('valid','approved','estimated')`,
    [row.contract_id, row.period_start, row.period_end]
  )[0]?.kwh;
  const measurementVariancePct = measured && row.consumption_kwh ? Math.round(((Number(row.consumption_kwh)-Number(measured))/Number(measured))*10000)/100 : null;
  const worst = Math.max(Math.abs(tariffVariancePct), measurementVariancePct == null ? 0 : Math.abs(measurementVariancePct));
  const validationStatus = measured == null ? "WARNING" : worst > 10 ? "FAIL" : worst > 3 ? "WARNING" : "PASS";
  const nextStatus = validationStatus === "PASS" ? "OPERATIONAL_APPROVAL" : "DATA_VALIDATION";
  env.sql.exec("UPDATE energy_invoices SET expected_net_grosze=?,variance_pct=?,validation_status=?,status=?,updated_at=? WHERE id=?",
    [expectedNet, tariffVariancePct, validationStatus, nextStatus, Date.now(), invoiceId]);
  if (validationStatus !== "PASS" && !env.sql.query("SELECT id FROM energy_alerts WHERE invoice_id=? AND alert_type='INVOICE_VARIANCE' AND status='OPEN'", [invoiceId]).length) {
    env.sql.exec("INSERT INTO energy_alerts (location_id,invoice_id,alert_type,severity,message,status,detected_at) VALUES (?,?, 'INVOICE_VARIANCE', ?, ?, 'OPEN', ?)",
      [row.location_id, invoiceId, validationStatus === "FAIL" ? "critical" : "warning", `Faktura ${row.invoice_number}: odchylenie taryfowe ${tariffVariancePct}%${measurementVariancePct==null?"; brak pełnych odczytów":`; odchylenie pomiaru ${measurementVariancePct}%`}`, Date.now()]);
  }
  return { invoiceId, expectedNetGrosze: expectedNet, tariffVariancePct, measuredKwh: measured ?? null, measurementVariancePct, validationStatus, nextStatus };
}

export function energyDashboard(env: any) {
  const now = Date.now(), since = now - 31*86400000;
  const summary = {
    suppliers: Number(env.sql.query<{n:number}>("SELECT COUNT(*) n FROM energy_suppliers WHERE status='active'")[0].n),
    contracts: Number(env.sql.query<{n:number}>("SELECT COUNT(*) n FROM energy_contracts WHERE status='active'")[0].n),
    meters: Number(env.sql.query<{n:number}>("SELECT COUNT(*) n FROM energy_meters WHERE status='active'")[0].n),
    kwh30d: Number(env.sql.query<{v:number|null}>("SELECT COALESCE(SUM(interval_kwh),0) v FROM energy_readings WHERE read_at>=?",[since])[0].v||0),
    outstandingGrossGrosze: Number(env.sql.query<{v:number|null}>("SELECT COALESCE(SUM(gross_grosze),0) v FROM energy_invoices WHERE status NOT IN ('PAID_RECONCILED','CANCELLED')")[0].v||0),
    overdue: Number(env.sql.query<{n:number}>("SELECT COUNT(*) n FROM energy_invoices WHERE due_at<? AND status NOT IN ('PAID_RECONCILED','CANCELLED')",[now])[0].n),
    openAlerts: Number(env.sql.query<{n:number}>("SELECT COUNT(*) n FROM energy_alerts WHERE status='OPEN'")[0].n),
  };
  const invoices = env.sql.query<any>(
    `SELECT i.*,s.name supplier_name,c.ppe,c.tariff,p.status payment_status,p.id payment_id
       FROM energy_invoices i JOIN energy_suppliers s ON s.id=i.supplier_id JOIN energy_contracts c ON c.id=i.contract_id
       LEFT JOIN energy_payment_orders p ON p.invoice_id=i.id ORDER BY i.due_at DESC LIMIT 50`
  );
  const meters = env.sql.query<any>(
    `SELECT m.id,m.serial,m.model,m.location_id,m.source_type,m.status,c.ppe,c.tariff,s.name supplier_name,
       MAX(r.read_at) last_reading_at, SUM(CASE WHEN r.read_at>=? THEN COALESCE(r.interval_kwh,0) ELSE 0 END) kwh_30d,
       SUM(CASE WHEN r.read_at>=? AND r.quality_status!='valid' THEN 1 ELSE 0 END) suspect_readings
     FROM energy_meters m JOIN energy_contracts c ON c.id=m.contract_id JOIN energy_suppliers s ON s.id=c.supplier_id
     LEFT JOIN energy_readings r ON r.meter_id=m.id GROUP BY m.id ORDER BY m.location_id`, [since,since]
  );
  const locations = env.sql.query<any>(
    `SELECT l.id,l.address,
      COALESCE((SELECT SUM(r.interval_kwh) FROM energy_readings r JOIN energy_meters m ON m.id=r.meter_id WHERE m.location_id=l.id AND r.read_at>=?),0) kwh,
      COALESCE((SELECT SUM(i.net_grosze) FROM energy_invoices i WHERE i.location_id=l.id AND i.period_end>=?),0) cost_net_grosze,
      COALESCE((SELECT SUM(c.packages) FROM collections c WHERE c.point_id=l.id AND c.collected_at>=?),0) packages
     FROM locations l WHERE l.deleted_at IS NULL AND l.id NOT LIKE 'SYN-%'
       AND (EXISTS(SELECT 1 FROM energy_meters m WHERE m.location_id=l.id) OR EXISTS(SELECT 1 FROM energy_invoices i WHERE i.location_id=l.id)) ORDER BY l.id`, [since,since,since]
  ).map((x:any)=>({...x,kwhPer1000:x.packages?Math.round(Number(x.kwh)/Number(x.packages)*100000)/100:null,costPer1000Grosze:x.packages?Math.round(Number(x.cost_net_grosze)/Number(x.packages)*1000):null}));
  return { summary, invoices, meters, locations, alerts: env.sql.query<any>("SELECT * FROM energy_alerts ORDER BY status='OPEN' DESC,severity DESC,detected_at DESC LIMIT 50") };
}

export function seedEnergyDemo(env: any, userId: number) {
  const key="seed:energy:v1";
  if(env.sql.query("SELECT id FROM event_log WHERE idempotency_key=?",[key]).length) return {ok:true,already:true};
  const now=Date.now(), day=86400000;
  const suppliers=[
    ["PGE Obrót — DEMO","8130268082","biznes.demo@pge.pl","12105000997603123456789123"],
    ["TAURON Sprzedaż — DEMO","9542583988","firma.demo@tauron.pl","92114020040000300201355387"]
  ];
  const supplierIds:number[]=[];
  for(const s of suppliers){env.sql.exec("INSERT INTO energy_suppliers (name,nip,contact_email,bank_account,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)",[...s,now,now]);supplierIds.push(Number(env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id));}
  const contractDefs:any[]=[
    [supplierIds[0],"NET-001","PL000001DEMO000001","C11",18,0.78,5900],
    [supplierIds[0],"NET-003","PL000001DEMO000003","C12a",24,0.82,7900],
    [supplierIds[1],"NET-011","PL000002DEMO000011","C11",15,0.75,6500]
  ];
  const contractIds:number[]=[];
  for(const d of contractDefs){env.sql.exec("INSERT INTO energy_contracts (supplier_id,location_id,ppe,tariff,contracted_power_kw,price_per_kwh,fixed_monthly_grosze,valid_from,valid_to,payment_days,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,NULL,14,'active',?,?)",[...d,Date.UTC(2026,0,1),now,now]);contractIds.push(Number(env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id));}
  const meterIds=["EM-NET-001","EM-NET-003","EM-NET-011"], base=[12450,16820,8420],daily=[18.4,24.8,13.2];
  for(let i=0;i<3;i++){
    env.sql.exec("INSERT INTO energy_meters (id,contract_id,location_id,device_id,serial,model,unit,multiplier,source_type,status,installed_at,created_at,updated_at) VALUES (?,?,?,?,?,'Shelly Pro 3EM DEMO','kWh',1,'iot_demo','active',?,?,?)",[meterIds[i],contractIds[i],contractDefs[i][1],null,`EMSN-2026-${String(i+1).padStart(3,'0')}`,Date.UTC(2026,6,1),now,now]);
    let cumulative=base[i];
    for(let d=30;d>=0;d--){const variation=((30-d)%7===0?1.22:1)+(i*.03);const interval=Math.round(daily[i]*variation*100)/100;cumulative=Math.round((cumulative+interval)*100)/100;env.sql.exec("INSERT INTO energy_readings (meter_id,read_at,cumulative_kwh,interval_kwh,source,quality_status,note,created_by,created_at) VALUES (?,?,?,?, 'iot_demo', ?, ?, ?, ?)",[meterIds[i],now-d*day,cumulative,interval,d===9&&i===1?'estimated':'valid',d===9&&i===1?'Brak pakietu IoT; estymacja z profilu 7 dni':null,userId,now]);}
  }
  const periodStart=now-30*day,periodEnd=now;
  const invoiceDefs:any[]=[
    [supplierIds[0],contractIds[0],"NET-001","PGE/DEMO/08/001",596.2,Math.round((596.2*.78+59)*100),now+8*day,"RECEIVED"],
    [supplierIds[0],contractIds[1],"NET-003","PGE/DEMO/08/003",798.4,Math.round((798.4*.82+79)*1.07*100),now+6*day,"RECEIVED"],
    [supplierIds[1],contractIds[2],"NET-011","TAURON/DEMO/08/011",425.7,Math.round((425.7*.75+65)*1.16*100),now-2*day,"RECEIVED"]
  ];
  const invoiceIds:number[]=[];
  for(const d of invoiceDefs){const net=d[5],vat=Math.round(net*.23);env.sql.exec("INSERT INTO energy_invoices (supplier_id,contract_id,location_id,invoice_number,period_start,period_end,consumption_kwh,net_grosze,vat_grosze,gross_grosze,due_at,status,validation_status,bank_account,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING',(SELECT bank_account FROM energy_suppliers WHERE id=?),?,?)",[d[0],d[1],d[2],d[3],periodStart,periodEnd,d[4],net,vat,net+vat,d[6],d[7],d[0],now,now]);const id=Number(env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);invoiceIds.push(id);validateEnergyInvoice(env,id);}
  env.sql.exec("INSERT INTO energy_payment_orders (invoice_id,amount_grosze,status,scheduled_at,approved_by,approved_at,export_reference,paid_at,created_at,updated_at) SELECT id,gross_grosze,'APPROVED_FOR_PAYMENT',due_at,?,?,?,NULL,?,? FROM energy_invoices WHERE id=?",[userId,now,"ENERGY-DEMO-PAY-001",now,now,invoiceIds[0]]);
  env.sql.exec("INSERT INTO energy_payment_orders (invoice_id,amount_grosze,status,scheduled_at,created_at,updated_at) SELECT id,gross_grosze,'ON_HOLD',due_at,?,? FROM energy_invoices WHERE id=?",[now,now,invoiceIds[1]]);
  env.sql.exec("INSERT INTO energy_payment_orders (invoice_id,amount_grosze,status,scheduled_at,created_at,updated_at) SELECT id,gross_grosze,'OVERDUE',due_at,?,? FROM energy_invoices WHERE id=?",[now,now,invoiceIds[2]]);
  env.sql.exec("INSERT INTO event_log (event_type,idempotency_key,payload_json,source,actor_id,created_at) VALUES ('seed.energy',?,?, 'admin_ui',?,?)",[key,JSON.stringify({suppliers:2,contracts:3,meters:3,readings:93,invoices:3}),userId,now]);
  return {ok:true,suppliers:2,contracts:3,meters:3,readings:93,invoices:3};
}
