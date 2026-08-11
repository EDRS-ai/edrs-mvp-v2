import journal from "./meta/_journal.json";
import m0000 from "./0000_prompt_6_indexes.sql";
import m0001 from "./0001_unify_points_locations.sql";

export default {
  journal,
  migrations: {
    m0000,
    m0001
  }
};
