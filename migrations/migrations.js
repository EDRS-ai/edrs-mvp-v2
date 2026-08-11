import journal from "./meta/_journal.json";
import m0000 from "./0000_prompt_6_indexes.sql";
import m0001 from "./0001_unify_points_locations.sql";
import m0002 from "./0002_payments_messages.sql";
import m0003 from "./0003_documents_statements.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001,
    m0002,
    m0003
  }
};
