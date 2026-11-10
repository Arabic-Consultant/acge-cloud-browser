import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type FixtureSite = {
  url: string;
  port: number;
  sent: Array<{ thread: string; text: string; at: string }>;
  close: () => Promise<void>;
};

const THREADS = [
  { id: "1", name: "شركة النور للاستشارات", preview: "نرغب بمعرفة تفاصيل برنامج التحول الرقمي والأسعار." },
  { id: "2", name: "مجموعة الأفق", preview: "هل تقدمون ورشة داخلية لثمانية موظفين؟" },
  { id: "3", name: "مؤسسة رؤية", preview: "نحتاج عرضاً لدراسة الجدوى قبل نهاية الشهر." },
];

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;background:#0b1220;color:#e6eefc;padding:24px}input,textarea{display:block;width:320px;margin:8px 0;padding:10px;border-radius:8px;border:1px solid #2a3b55;background:#111c2e;color:#e6eefc}a{color:#8ec5ff}.bubble{background:#16233a;padding:8px 12px;border-radius:8px;margin:6px 0;max-width:520px}button{padding:10px 18px;border-radius:8px;border:1px solid #3b7fc4;background:#1b4a7a;color:#fff}</style>
</head><body>${body}</body></html>`;
}

function loginPage(error = ""): string {
  return page(
    "دخول",
    `<h1>تسجيل الدخول</h1>${error ? `<p role="alert">${error}</p>` : ""}
     <form method="post" action="/login">
       <input name="username" aria-label="Username" placeholder="اسم المستخدم" autofocus autocomplete="username">
       <input name="password" type="password" aria-label="Password" placeholder="كلمة المرور" autocomplete="current-password">
       <button type="submit" aria-label="Sign in">دخول</button>
     </form>
     <p><small>بيئة اختبار محلية وليست منصة تواصل حقيقية.</small></p>`,
  );
}

function inboxPage(): string {
  const items = THREADS.map(
    (thread) =>
      `<div class="bubble" role="listitem"><strong>${thread.name}</strong><div>${thread.preview}</div><a href="/thread/${thread.id}">فتح المحادثة</a></div>`,
  ).join("");
  return page("صندوق الرسائل", `<h1>صندوق الرسائل</h1><div role="list">${items}</div>`);
}

function threadPage(id: string, messages: Array<{ author: string; text: string }>): string {
  const thread = THREADS.find((item) => item.id === id) ?? THREADS[0];
  const bubbles = messages
    .map((message) => `<div class="bubble" data-author="${message.author}">${message.text}</div>`)
    .join("");
  return page(
    thread.name,
    `<h1>${thread.name}</h1><div id="messages">${bubbles}</div>
     <textarea id="composer" aria-label="Message" placeholder="اكتب رسالة"></textarea>
     <button id="send" aria-label="Send" type="button">إرسال</button>
     <script>
       const composer = document.getElementById("composer");
       const send = document.getElementById("send");
       send.addEventListener("click", async () => {
         const text = composer.value.trim();
         if (!text) return;
         const bubble = document.createElement("div");
         bubble.className = "bubble";
         bubble.dataset.author = "me";
         bubble.textContent = text;
         document.getElementById("messages").appendChild(bubble);
         composer.value = "";
         await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: "${id}", text }) });
       });
     </script>`,
  );
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseCookies(header?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  }
  return cookies;
}

export async function startFixture(): Promise<FixtureSite> {
  const sent: Array<{ thread: string; text: string; at: string }> = [];
  const initialMessages = new Map<string, Array<{ author: string; text: string }>>(
    THREADS.map((thread) => [thread.id, [{ author: "client", text: thread.preview }]]),
  );

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, html: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    };
    const redirect = (location: string, cookie?: string) => {
      response.writeHead(302, { location, ...(cookie ? { "set-cookie": cookie } : {}) });
      response.end();
    };
    const loggedIn = parseCookies(request.headers.cookie).sid === "ok";

    if (url.pathname === "/login" && request.method === "GET") return send(200, loginPage());
    if (url.pathname === "/login" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("username") === "owner" && form.get("password") === "secret-pass") {
        return redirect("/inbox", "sid=ok; Path=/; HttpOnly; SameSite=Lax");
      }
      return send(401, loginPage("بيانات الدخول غير صحيحة"));
    }
    if (url.pathname === "/api/send" && request.method === "POST") {
      const payload = JSON.parse((await readBody(request)) || "{}") as { thread?: string; text?: string };
      if (!loggedIn) return send(401, "unauthorized");
      sent.push({ thread: String(payload.thread ?? ""), text: String(payload.text ?? ""), at: new Date().toISOString() });
      const messages = initialMessages.get(String(payload.thread ?? "1")) ?? [];
      messages.push({ author: "me", text: String(payload.text ?? "") });
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/api/state") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ sent }));
    }
    if (url.pathname === "/inbox") {
      if (!loggedIn) return redirect("/login");
      return send(200, inboxPage());
    }
    const threadMatch = /^\/thread\/(\d)$/.exec(url.pathname);
    if (threadMatch) {
      if (!loggedIn) return redirect("/login");
      return send(200, threadPage(threadMatch[1], initialMessages.get(threadMatch[1]) ?? []));
    }
    send(404, page("غير موجود", "<h1>404</h1>"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sent,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
