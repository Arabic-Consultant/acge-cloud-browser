export type PlatformId = "facebook" | "instagram" | "whatsapp" | "linkedin" | "custom";

export type ActionMode = "read_only" | "approval_required";

export type SessionCheck = {
  /** URL opened to prove the stored session still works. */
  url: string;
  /** If the final URL matches this pattern the session is expired. */
  expiredUrlPattern?: string;
  /** Selector that must exist for a valid session. */
  loggedInSelector?: string;
  /** Visible text that proves the user is logged out (QR / login wall). */
  loggedOutText?: string[];
};

export type PlatformPolicy = {
  id: PlatformId;
  label: string;
  hosts: string[];
  loginUrl: string;
  startUrl: string;
  inboxUrl?: string;
  sessionCheck: SessionCheck;
  draftAllowed: boolean;
  actionMode: ActionMode;
  /** Human readable explanation of the automation boundary, shown in the UI. */
  actionNote: string;
  /** Accessible-name patterns for the final send control. */
  sendControlPattern: string;
  /** Selectors used to locate the message composer. */
  composerSelectors: string[];
};

const META_SEND = "send|إرسال|أرسل|reply|رد|نشر|publish|post";

export const PLATFORMS: Record<Exclude<PlatformId, "custom">, PlatformPolicy> = {
  facebook: {
    id: "facebook",
    label: "Facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "web.facebook.com"],
    loginUrl: "https://www.facebook.com/login/",
    startUrl: "https://www.facebook.com/messages/",
    inboxUrl: "https://www.facebook.com/messages/",
    sessionCheck: {
      url: "https://www.facebook.com/me",
      expiredUrlPattern: "/(login|checkpoint|recover)",
      // Only markers that appear on the signed-in shell; generic banners and
      // [data-pagelet] also exist on the public login page.
      loggedInSelector: "[aria-label='Your profile'], [aria-label='حسابك'], [aria-label='Your profile picture']",
      loggedOutText: ["log in to facebook", "تسجيل الدخول إلى فيسبوك", "forgot password"],
    },
    draftAllowed: true,
    actionMode: "approval_required",
    actionNote: "الوكيل يفتح المحادثة ويكتب المسودة داخل المربع، ولا ينفذ الإرسال إلا بموافقتك الصريحة على الرسالة نفسها.",
    sendControlPattern: "^(send|إرسال|أرسل)$",
    composerSelectors: ["div[contenteditable='true'][role='textbox']", "div[contenteditable='true']", "textarea"],
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    hosts: ["instagram.com", "www.instagram.com"],
    loginUrl: "https://www.instagram.com/accounts/login/",
    startUrl: "https://www.instagram.com/direct/inbox/",
    inboxUrl: "https://www.instagram.com/direct/inbox/",
    sessionCheck: {
      url: "https://www.instagram.com/direct/inbox/",
      expiredUrlPattern: "/(accounts/login|challenge|emailsignup)",
      loggedInSelector: "a[href='/direct/inbox/'], svg[aria-label='Messenger'], a[href='/explore/']",
      loggedOutText: ["log in to instagram", "تسجيل الدخول إلى إنستغرام"],
    },
    draftAllowed: true,
    actionMode: "approval_required",
    actionNote: "يجهّز الرد داخل صندوق الرسائل ويتوقف قبل الإرسال حتى توافق على نص الرد.",
    sendControlPattern: META_SEND,
    composerSelectors: ["div[contenteditable='true'][role='textbox']", "textarea[placeholder]", "textarea"],
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp Web",
    hosts: ["whatsapp.com", "web.whatsapp.com"],
    loginUrl: "https://web.whatsapp.com/",
    startUrl: "https://web.whatsapp.com/",
    sessionCheck: {
      url: "https://web.whatsapp.com/",
      // The QR/link screen renders before the chat list exists.
      loggedOutText: ["scan the qr code", "امسح رمز qr", "link with phone number", "اربط برقم الهاتف", "link a device", "ربط جهاز", "loading your chats", "جارٍ تحميل"],
      loggedInSelector: "#pane-side, [data-testid='chat-list'], [aria-label='Chat list'], [aria-label='قائمة المحادثات']",
    },
    draftAllowed: true,
    actionMode: "approval_required",
    actionNote: "يفتح المحادثة التي تحددها ويكتب رداً واحداً، ولا يضغط إرسال إلا بعد موافقتك. لا رسائل جماعية.",
    sendControlPattern: "^(send|إرسال|أرسل)$",
    composerSelectors: ["div[contenteditable='true'][role='textbox']", "footer div[contenteditable='true']"],
  },
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    hosts: ["linkedin.com", "www.linkedin.com"],
    loginUrl: "https://www.linkedin.com/login",
    startUrl: "https://www.linkedin.com/messaging/",
    inboxUrl: "https://www.linkedin.com/messaging/",
    sessionCheck: {
      url: "https://www.linkedin.com/feed/",
      expiredUrlPattern: "/(login|authwall|checkpoint|uas/login)",
      loggedInSelector: ".global-nav, [data-test-global-nav], a[href='/messaging/']",
    },
    draftAllowed: true,
    actionMode: "read_only",
    actionNote: "LinkedIn يمنع الأتمتة الخارجية للإجراءات (رسائل، دعوات، إعجابات). القراءة والتلخيص وكتابة النص فقط؛ لا ضغط على أي زر إرسال أو دعوة.",
    sendControlPattern: "^(send|إرسال)$",
    composerSelectors: ["div[contenteditable='true'][role='textbox']", "textarea"],
  },
};

export const CUSTOM_POLICY: PlatformPolicy = {
  id: "custom",
  label: "موقع مخصص",
  hosts: [],
  loginUrl: "",
  startUrl: "",
  sessionCheck: { url: "", expiredUrlPattern: "/(login|signin|auth)", loggedInSelector: "" },
  draftAllowed: true,
  actionMode: "approval_required",
  actionNote: "موقع مخصص للتحقق والاختبار. نفس ضوابط الموافقة الصريحة مطبقة.",
  sendControlPattern: META_SEND,
  composerSelectors: ["textarea", "input[type='text']", "div[contenteditable='true']"],
};

export function policyFor(platform: PlatformId): PlatformPolicy {
  return platform === "custom" ? CUSTOM_POLICY : PLATFORMS[platform];
}

export function platformHosts(platform: PlatformId, accountStartUrl?: string): string[] {
  const policy = policyFor(platform);
  const hosts = [...policy.hosts];
  for (const raw of [accountStartUrl, policy.loginUrl, policy.sessionCheck.url, policy.inboxUrl]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host && !hosts.includes(host)) hosts.push(host);
    } catch {
      // ignore malformed configured URLs
    }
  }
  return hosts;
}

/** Actions that must never be executed automatically, per platform ToS. */
export function actionExecutionBlocked(platform: PlatformId, allowLinkedinActions: boolean): string | null {
  if (platform === "linkedin") {
    return allowLinkedinActions ? null : "linkedin_automation_prohibited";
  }
  if (policyFor(platform).actionMode === "read_only") {
    return "platform_read_only";
  }
  return null;
}

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sid|datr|xs|c_user|sb|li_at|JSESSIONID|sessionid|csrftoken|ct0|auth_token)\s*=\s*[^\s;,]{1,}/gi, "$1=[redacted]"],
  [/([a-z0-9_-]*(session|token|secret|password|xs|c_user|li_at|jsessionid)[a-z0-9_-]*)\s*[:=]\s*[^\s;,]{6,}/gi, "$1=[redacted]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "[redacted-jwt]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi, "$1[redacted]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[redacted-blob]"],
];

/** Scrubs cookies, bearer tokens and key material from logs and API output. */
export function redact(text: string, limit = 8000): string {
  let out = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) out = out.replace(pattern, replacement);
  return out.slice(0, limit);
}
