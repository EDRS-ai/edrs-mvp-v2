-- PROMPT 8: unifikacja points/locations.
-- points (NET-xxx, legacy demo PROMPT 0) kopiowane do kanonicznej tabeli locations,
-- z zachowaniem id (collections.point_id / event_log.point_id nadal pasują).
-- investor_org_id mapowany po IDENTYCZNEJ nazwie investors.name = organizations.name
-- (seed PROMPT 1 celowo trzyma te same nazwy w obu tabelach).
-- Koordynaty: centroidy dzielnic Warszawy + deterministyczny jitter z numeru punktu
-- (points nie miały lat/lng — bez tego punkty NET są niewidoczne na mapie live).
-- Idempotentne (INSERT OR IGNORE). Na świeżej bazie (points puste przed seedem)
-- no-op — seed.ts robi wtedy dual-write samodzielnie.
INSERT OR IGNORE INTO locations (id, address, district, lat, lng, investor_org_id, fill_level, status, last_collection_at, monthly_packages, created_at, updated_at, version)
SELECT
  p.id,
  p.address,
  p.district,
  (CASE p.district
    WHEN 'Wilanów' THEN 52.157
    WHEN 'Mokotów' THEN 52.193
    WHEN 'Bielany' THEN 52.292
    WHEN 'Praga' THEN 52.253
    WHEN 'Targówek' THEN 52.291
    WHEN 'Ursynów' THEN 52.140
    WHEN 'Wola' THEN 52.236
    WHEN 'Ochota' THEN 52.209
    WHEN 'Żoliborz' THEN 52.269
    WHEN 'Śródmieście' THEN 52.229
    ELSE 52.230 END) + (CAST(substr(p.id, 5) AS INTEGER) % 5) * 0.006,
  (CASE p.district
    WHEN 'Wilanów' THEN 21.090
    WHEN 'Mokotów' THEN 21.045
    WHEN 'Bielany' THEN 20.934
    WHEN 'Praga' THEN 21.045
    WHEN 'Targówek' THEN 21.065
    WHEN 'Ursynów' THEN 21.050
    WHEN 'Wola' THEN 20.960
    WHEN 'Ochota' THEN 20.980
    WHEN 'Żoliborz' THEN 20.985
    WHEN 'Śródmieście' THEN 21.012
    ELSE 21.010 END) + (CAST(substr(p.id, 5) AS INTEGER) % 7) * 0.008,
  (SELECT o.id FROM organizations o JOIN investors i ON i.name = o.name WHERE i.id = p.investor_id LIMIT 1),
  p.fill_level,
  p.status,
  p.last_collection_at,
  p.monthly_packages,
  p.created_at,
  p.created_at,
  1
FROM points p;
