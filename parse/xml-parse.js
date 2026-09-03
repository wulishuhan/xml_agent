/**
 * ============================================================
 * XML Extractor
 * ============================================================
 */

function extractXML(response) {
  if (!response) {
    throw new Error("returned empty response");
  }

  let text = response.trim();

  /**
   * 去掉 Markdown XML 代码块
   */
  text = text.replace(/^```xml\s*/i, "");

  text = text.replace(/^```\s*/, "");

  text = text.replace(/\s*```$/i, "");

  text = text.trim();

  /**
   * read
   */
  if (text.startsWith("<read")) {
    if (!text.includes("/>")) {
      throw new Error("Incomplete read XML");
    }

    return text;
  }

  /**
   * write
   */
  if (text.startsWith("<write")) {
    if (!text.includes("<![CDATA[")) {
      throw new Error("Write XML missing CDATA");
    }

    if (!text.includes("]]></write>")) {
      throw new Error("Incomplete write XML");
    }

    return text;
  }

  /**
   * exec
   */
  if (text.startsWith("<exec")) {
    if (!text.includes("/>")) {
      throw new Error("Incomplete exec XML");
    }

    return text;
  }

  /**
   * answer
   */
  if (text.startsWith("<answer")) {
    if (!text.includes("<![CDATA[")) {
      throw new Error("Answer XML missing CDATA");
    }

    if (!text.includes("]]></answer>")) {
      throw new Error("Incomplete answer XML");
    }

    return text;
  }

  /**
   * done
   */
  if (text.startsWith("<done")) {
    if (!text.includes("<done/>") && !text.includes("<done />")) {
      throw new Error("Incomplete done XML");
    }

    return text;
  }

  throw new Error("did not return a supported XML Action.\n\n" + "Response:\n" + response);
}

module.exports = {
  extractXML,
};
