const fs = require("node:fs");
const babel = require("@babel/core");

const file = "public/legacy-connect.js";
const result = babel.transformFileSync(file, {
  comments: false,
  compact: true,
  presets: [[require.resolve("@babel/preset-env"), { targets: { chrome: "38" }, bugfixes: true }]],
});

fs.writeFileSync(file, `${result.code}\n`);
