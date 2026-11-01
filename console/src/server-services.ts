import {
  defineServerServices,
  service,
} from "@ccslabs/xtend-maraca/server-services";
import type { Request, CoreResponse } from "./contracts.ts";
import { coreRequest } from "../server/core-client.mjs";
export default defineServerServices({
  "cuo.core": service<Request, CoreResponse>({
    kind: "query",
    async invoke(input, context) {
      return coreRequest(input, context);
    },
  }),
});
