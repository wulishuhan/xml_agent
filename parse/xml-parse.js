const { XMLParser } = require("fast-xml-parser");

/**
 * XML Parser
 * 1. 清理模型返回的 XML
 * 2. 解析 XML
 * 3. 校验 XML Action
 * 4. 返回结构化 Action
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
});

/**
 * 清理 Markdown XML 代码块
 */
function cleanXML(response) {
  if (!response || typeof response !== "string") {
    throw new Error("returned empty response");
  }

  let text = response.trim();

  // ```xml
  text = text.replace(/^```xml\s*/i, "");

  // ```
  text = text.replace(/^```\s*/, "");

  // ```
  text = text.replace(/\s*```$/i, "");

  return text.trim();
}

/**
 * 获取节点文本
 */
function getText(node) {
  if (node === undefined || node === null) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  if (typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }

  if (typeof node === "object" && node["#text"] !== undefined) {
    return String(node["#text"]);
  }

  return "";
}

/**
 * 校验 Action
 */
function validateAction(action, node) {
  switch (action) {
    case "read":
      if (!node || typeof node !== "object") {
        throw new Error("read action is invalid");
      }

      if (!node["@_path"]) {
        throw new Error("read requires path");
      }

      return;

    case "write":
      if (!node || typeof node !== "object") {
        throw new Error("write action is invalid");
      }

      if (!node["@_path"]) {
        throw new Error("write requires path");
      }

      if (!getText(node)) {
        throw new Error("write content cannot be empty");
      }

      return;

    case "exec":
      if (!node || typeof node !== "object") {
        throw new Error("exec action is invalid");
      }

      if (!node["@_command"]) {
        throw new Error("exec requires command");
      }

      return;

    case "answer":
      if (!getText(node).trim()) {
        throw new Error("answer content cannot be empty");
      }

      return;

    case "done":
      return;

    default:
      throw new Error(`Unknown XML Action: ${action}`);
  }
}

/**
 * Extract XML Action
 *
 * 返回：
 *
 * {
 *   action: "read",
 *   node: {
 *     "@_path": "package.json"
 *   }
 * }
 *
 * Runtime 直接使用这个对象。
 */
function extractXML(response) {
  const text = cleanXML(response);

  let parsed;

  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new Error(`Invalid XML: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid XML");
  }

  const actionNames = Object.keys(parsed);

  /**
   * 必须且只能有一个 Action
   */
  if (actionNames.length === 0) {
    throw new Error("No XML Action found");
  }

  if (actionNames.length !== 1) {
    throw new Error(`Exactly one XML Action is required, but received ${actionNames.length}`);
  }

  const action = actionNames[0];
  const node = parsed[action];

  validateAction(action, node);

  return {
    action,
    node,
  };
}

module.exports = {
  extractXML,
  getText,
};
