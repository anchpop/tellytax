export function dashboardPage(id: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Chad Nauseam News - Dashboard</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="root"></div>
  <script>const DIGEST_ID = ${JSON.stringify(id)};</script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}
