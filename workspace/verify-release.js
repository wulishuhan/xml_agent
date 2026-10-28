const fs = require("fs");

const artifacts = [
    "release/XMLAgent-Setup-1.0.7-x64.exe",
    "release/XMLAgent-Setup-1.0.7-x64.exe.blockmap",
    "release/XMLAgent-Portable-1.0.7-x64.exe",
    "release/XMLAgent-1.0.7-x64.zip",
    "release/latest.yml",
    "release/win-unpacked/XMLAgent.exe",
];

let failed = 0;

for (const file of artifacts) {
    if (!fs.existsSync(file)) {
        console.log("MISSING: " + file);
        failed += 1;
        continue;
    }
    const size = fs.statSync(file).size;
    console.log("OK: " + file + "  (" + (size / 1024 / 1024).toFixed(2) + " MB)");
}

const latest = fs.readFileSync("release/latest.yml", "utf8");
const versionLine = latest
    .split(/\r?\n/)
    .filter(function (line) {
        return line.indexOf("version:") !== -1;
    })
    .join(" | ");
console.log("latest.yml: " + versionLine);

if (latest.indexOf("1.0.7") === -1) {
    console.log("WARNING: latest.yml does not contain 1.0.7");
    failed += 1;
}

if (failed > 0) {
    throw new Error(failed + " artifact check(s) failed");
}
console.log("all 1.0.7 artifacts verified");
