import assert from "assert";
import MicroManager, * as mm from "../src/MicroManager";

describe("MicroManager", () => {
    describe("static", () => {
        describe("matchCommand", () => {
            it("should match the correct command", () => {
                const tests = [
                    ["clock in", ["UPDATE_CLOCK", "in"]],
                    ["clock in", ["UPDATE_CLOCK", "in"]],
                    ["clock out", ["UPDATE_CLOCK", "out"]],
                    ["clock OUT", ["UPDATE_CLOCK", "out"]],
                    ["no clock out", ["CANCEL_CLOCK_OUT"]],
                    ["don't clock out", ["CANCEL_CLOCK_OUT"]],
                    ["dont clock out", ["CANCEL_CLOCK_OUT"]],
                    ["stop clock out", ["CANCEL_CLOCK_OUT"]],
                ];

                tests.forEach(([ input, output ]) => {
                    assert.deepEqual(mm.matchCommand(input), output, `Failed input: ${input}`);
                });
            });
        });
    });
});