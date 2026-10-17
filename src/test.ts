/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric } from "convex/server";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Registers the component on a convex-test instance.
 *
 * @param t - The test instance, from `convexTest(schema, modules)`.
 * @param name - The name the component is installed under in `convex.config.ts`.
 * @returns The component's API, to pass to `new AzureBlob(...)` in tests.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "azureBlob") {
  t.registerComponent(name, schema, modules);
  return componentsGeneric()[name] as unknown as ComponentApi;
}

export default { register, schema, modules };
