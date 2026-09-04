const { extractXML } = require("../parse/xml-parse");

function test(cases) {
  for (const xml of cases) {
    try {
      const action = extractXML(xml);

      console.log("PASS");
      console.log(xml);
      console.log(action);
    } catch (error) {
      console.log("FAIL");
      console.log(xml);
      console.log(error.message);
    } finally {
      console.log("--------------------------------");
    }
  }
}

// normal test cases
const cases1 = [
  '<read path="src" />',

  '<write path="test.txt"><![CDATA[hello world]]></write>',

  '<exec command="node -v" />',

  "<answer><![CDATA[测试完成]]></answer>",

  "<done />",
];

// xml code block test cases
const cases2 = ['```xml\n<read path="src" />\n```', '```\n<exec command="node -v" />\n```', "```xml\n<done/>\n```"];

// invalid test cases
const cases3 = ["", "hello world", "<foo />", "<read></read>", "<exec></exec>", '<read path="src"', '<read path="src" /><done/>'];

// run tests

// normal test cases
test(cases1);

// xml code block test cases
test(cases2);

// invalid test cases
test(cases3);
