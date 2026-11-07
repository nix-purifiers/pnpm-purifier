#!/usr/bin/env node
import assert from "node:assert/strict";import ms from "ms";assert.equal(ms("1h"),3600000);console.log("milliseconds: "+ms("1h"));
