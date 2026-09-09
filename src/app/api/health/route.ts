export function GET() {
  return Response.json({
    service: "key-manager",
    status: "ok",
  });
}
