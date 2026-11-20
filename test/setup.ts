// The test suites cover the full pipeline, including businesses with their own
// website. Tests of the no-website-only default switch it back explicitly.
import { setOwnWebsitesInScope } from "../src/websiteClass.js";

setOwnWebsitesInScope(true);
