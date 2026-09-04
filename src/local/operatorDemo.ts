process.env.OPERATOR_DEMO_MODE = "true";
process.env.NODE_ENV = "development";
process.env.OPERATOR_DATABASE_PATH = ".runtime/operator-demo.sqlite";
process.env.OPERATOR_MEDIA_PATH = ".runtime/demo-media";

const { seedOperatorDemo } = await import("./seedOperatorDemo.js");
await seedOperatorDemo();
await import("../server.js");
