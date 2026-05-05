import { Arker } from "../src/index.ts";

const API_KEY = process.env.ARKER_API_KEY!;
const NLB = "http://arker-scheduler-nlb-47ef2284d91cefd7.elb.us-west-2.amazonaws.com";

const a = new Arker({ apiKey: API_KEY, baseUrl: NLB });

console.log(`base_url: ${(a as any).baseUrl}`);

// fork from arkuntu (resolves client-side via SOURCE_ALIASES → no network)
console.log("\n→ fork(arkuntu)");
const vm = await a.vm("arkuntu").fork({ name: "nlb-smoke" });
console.log(`  ✅ vm.id=${vm.id}`);

console.log("\n→ run(echo hello)");
const r = await vm.run("echo hello");
console.log(`  ✅ exitCode=${r.exitCode} stdout="${new TextDecoder().decode(r.stdout).trim()}"`);

console.log("\n→ writeFile + readFile");
await vm.sync.writeFile("/home/user/x.txt", "hi from sdk\n");
const data = await vm.sync.readFile("/home/user/x.txt");
console.log(`  ✅ read back: "${new TextDecoder().decode(data).trim()}"`);

console.log("\n→ delete");
await vm.delete();
console.log(`  ✅ deleted`);

console.log("\nAll NLB calls succeeded over HTTP/1.1");
