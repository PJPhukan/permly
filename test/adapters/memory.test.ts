import { memoryAdapter } from "../../src/adapters/memory";
import { runAdapterContract } from "./adapter-contract";

runAdapterContract("memory", async () => memoryAdapter());
