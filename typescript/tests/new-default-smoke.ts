import { Arker } from "../src/index.ts";

const a = new Arker({
  apiKey: process.env.ARKER_API_KEY!,
  baseUrl: "https://aws-burst-us-west-2.arker.ai",
});
console.log("base_url:", (a as any).baseUrl);

const vm = await a.vm("arkuntu").fork({ name: "new-default-test" });
console.log("  ✅ fork →", vm.id);

const r = await vm.run("echo hello");
console.log(`  ✅ run exitCode=${r.exitCode} stdout="${new TextDecoder().decode(r.stdout).trim()}"`);

await vm.sync.writeFile("/home/user/x.txt", "roundtrip\n");
const data = await vm.sync.readFile("/home/user/x.txt");
console.log(`  ✅ file roundtrip: "${new TextDecoder().decode(data).trim()}"`);

await vm.delete();
console.log("  ✅ delete");
