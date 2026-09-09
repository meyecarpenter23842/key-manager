import process from "node:process";

export function createStructuredLogger(write = (line) => process.stdout.write(line)) {
  return (event) => {
    write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  };
}
