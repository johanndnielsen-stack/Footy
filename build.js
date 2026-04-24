const fs = require("fs");

const hfKey = process.env.FC_HF_KEY || "";
const ak    = process.env.FC_AK     || "";

if (!hfKey) console.warn("WARNING: FC_HF_KEY is not set");
if (!ak)    console.warn("WARNING: FC_AK is not set");

const html = fs.readFileSync("Index.html", "utf8")
  .replace("__FC_HF_KEY__", hfKey)
  .replace("__FC_AK__",     ak);

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", html);
console.log("Build complete. Keys injected.");
