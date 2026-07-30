const Database = require("better-sqlite3");
const os = require("os");
const db = new Database(`${os.homedir()}/.conveyer-grok/grok.db`);
db.prepare("UPDATE runs SET config_json = ?, status = 'error' WHERE id = ?")
  .run(JSON.stringify({ autoReuse: true }), '95afddf1-aaa0-4ce9-859e-badf0ca060c5');
const r = db.prepare("SELECT status, config_json FROM runs WHERE id='95afddf1-aaa0-4ce9-859e-badf0ca060c5'").get();
console.log(r);
