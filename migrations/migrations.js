import journal from "./meta/_journal.json";
import m0000 from "./0000_prompt_6_indexes.sql";
import m0001 from "./0001_unify_points_locations.sql";
import m0002 from "./0002_payments_messages.sql";
import m0003 from "./0003_documents_statements.sql";
import m0004 from "./0004_mvp_settlement_legs_driver_events.sql";
import m0005 from "./0005_energy_management.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003,
    m0004,
    m0005
  }
};
