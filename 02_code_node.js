/**
 * n8n Code Node — "Calculate Delete Count + Sheet Routing + Email Flag"
 * ------------------------------------------------
 * يُوضع بعد AI Agent node مباشرة.
 *
 * يتعامل مع مدخلين منفصلين قادمين من AI Agent:
 *
 * (A) مسار الحذف:
 * {
 *   action_type: "delete" | "unclear",
 *   target_decision_id: "LAST" | null,
 *   delete_search_term: string | null,
 *   delete_count_raw: string,
 *   delete_scope: "last_n" | "single_last" | "by_search_term" | "all"
 * }
 * → يُخرج: { action_type, target_decision_id, delete_search_term, delete_count }
 *
 * (B) مسار الرسالة/التحليل ($json.message + $json.send_email):
 * message = JSON منظم من AI Agent بـ 4 حقول:
 *   { metadata_context, quantitative_scoring, qualitative_analysis_diagnosis, execution_recommendation }
 * send_email = نص خام من AI Agent يدل على نية إرسال إيميل (مثل: "نعم"، "بدي ايميل"، "" ، null...)
 *
 * → يُخرج:
 * {
 *   sheets: {
 *     metadata_context: {...} | string,
 *     quantitative_scoring: {...} | string,
 *     qualitative_analysis_diagnosis: {...} | string,
 *     execution_recommendation: {...} | string
 *   },
 *   send_email: true | false   // boolean نهائي حتمي، فقط لو طلب صريح
 * }
 */

// ---------- 1) قاموس الأرقام العربية (قابل للتوسعة من نقطة واحدة) ----------
const ARABIC_NUMBER_MAP = {
  // المفرد / المثنى الخاص بكلمة "قرار"
  "قرار": 1,
  "قرارين": 2,
  "قراران": 2,

  // الأرقام الأساسية (مع/بدون تاء مربوطة، أخطاء إملائية شائعة)
  "واحد": 1, "واحدة": 1,
  "اثنين": 2, "اثنان": 2, "ثنين": 2,
  "ثلاثة": 3, "ثلاثه": 3, "تلاتة": 3, "تلاته": 3,
  "اربعة": 4, "أربعة": 4, "اربعه": 4, "أربعه": 4,
  "خمسة": 5, "خمسه": 5,
  "ستة": 6, "سته": 6,
  "سبعة": 7, "سبعه": 7,
  "ثمانية": 8, "ثمانيه": 8, "تمانية": 8,
  "تسعة": 9, "تسعه": 9,
  "عشرة": 10, "عشره": 10,

  // صيغ مختصرة شائعة في العامية
  "خمس": 5,
  "عشر": 10,
  "تلات": 3,
  "اربع": 4,
  "ست": 6,
  "سبع": 7,
  "تمن": 8,
  "تسع": 9,
};

// ---------- 2) دالة استخراج أرقام إنجليزية (مع دعم الأرقام العربية ٠-٩) ----------
function extractDigitNumber(text) {
  if (!text) return null;

  // تحويل الأرقام العربية-هندية (٠١٢٣٤٥٦٧٨٩) إلى لاتينية
  const arabicIndicDigits = "٠١٢٣٤٥٦٧٨٩";
  let normalized = text.replace(/[٠-٩]/g, (d) => arabicIndicDigits.indexOf(d));

  const match = normalized.match(/\d+/);
  if (match) {
    const num = parseInt(match[0], 10);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

// ---------- 3) دالة استخراج العدد من كلمات عربية ----------
function extractWordNumber(text) {
  if (!text) return null;

  // تنظيف النص: إزالة "ال" التعريف، علامات تشكيل، مسافات زائدة
  const cleaned = text
    .trim()
    .replace(/^ال/, "")
    .replace(/[\u064B-\u0652]/g, ""); // إزالة التشكيل

  // مطابقة مباشرة
  if (ARABIC_NUMBER_MAP.hasOwnProperty(cleaned)) {
    return ARABIC_NUMBER_MAP[cleaned];
  }

  // مطابقة جزئية (في حال احتوى النص على كلمة الرقم ضمن جملة أطول)
  for (const [word, value] of Object.entries(ARABIC_NUMBER_MAP)) {
    if (cleaned.includes(word)) {
      return value;
    }
  }

  return null;
}

// ---------- 4) الدالة الرئيسية لحساب delete_count ----------
function resolveDeleteCount(parsed) {
  const scope = parsed.delete_scope;
  const raw = (parsed.delete_count_raw || "").trim();
  const searchTerm = parsed.delete_search_term;

  // الحالة أ: الحذف بالاسم/الموضوع — العدد = عدد المصطلحات المفصولة بفاصلة
  if (scope === "by_search_term" && searchTerm) {
    const terms = searchTerm
      .split(/[,،]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return Math.max(terms.length, 1);
  }

  // الحالة ب: "احذف آخر قرار" بدون عدد
  if (scope === "single_last" || !raw) {
    return 1;
  }

  // الحالة ج: "آخر N قرار/قرارات" — جرب الأرقام الرقمية أولاً
  const digitNum = extractDigitNumber(raw);
  if (digitNum !== null) return digitNum;

  // ثم جرب الكلمات العربية
  const wordNum = extractWordNumber(raw);
  if (wordNum !== null) return wordNum;

  // الحالة الافتراضية: تعذر تحديد العدد بوضوح
  return 1;
}

// ---------- 5) دالة استخراج نية إرسال الإيميل (boolean حتمي) ----------
// قاعدة العمل: send_email = true فقط لو المستخدم طلب صراحة (بدي ايميل / ابعتلي ايميل / اي صيغة تأكيد واضحة)
// أي غموض أو سكوت = false (الافتراضي الآمن، عشان ما نبعت ايميلات غير مطلوبة)
const EMAIL_POSITIVE_PATTERNS = [
  "بدي ايميل",
  "بدي إيميل",
  "ابعتلي ايميل",
  "ابعتلي إيميل",
  "ابعت ايميل",
  "ابعت إيميل",
  "بعتلي ايميل",
  "ارسل ايميل",
  "أرسل إيميل",
  "ارسلي ايميل",
  "ايميلي",
  "إيميلي",
  "send email",
  "email me",
];

const EMAIL_NEGATIVE_PATTERNS = [
  "لا تبعت",
  "ما بدي ايميل",
  "ما بدي إيميل",
  "بدون ايميل",
  "بلا ايميل",
  "no email",
];

function resolveSendEmail(rawValue) {
  // قبول boolean مباشر إذا أرسله AI Agent مسبقاً كـ boolean حقيقي
  if (typeof rawValue === "boolean") return rawValue;

  if (rawValue === null || rawValue === undefined) return false;

  const text = String(rawValue).trim().toLowerCase();
  if (text.length === 0) return false;

  // فحص النفي أولاً (أولوية أعلى، لتجنب "ما بدي ايميل" يصير true بسبب وجود كلمة "ايميل")
  for (const neg of EMAIL_NEGATIVE_PATTERNS) {
    if (text.includes(neg)) return false;
  }

  for (const pos of EMAIL_POSITIVE_PATTERNS) {
    if (text.includes(pos)) return true;
  }

  // فحص أضيق لـ "نعم"/"yes"/"true" بدون تضارب مع "لا"/كلمات أخرى تحتوي "نعم" كجزء (نادر بالعربي لكن للأمان)
  if (text === "نعم" || text === "yes" || text === "true" || text === "1") {
    return true;
  }
  if (text === "لا" || text === "no" || text === "false" || text === "0") {
    return false;
  }

  // الافتراضي الآمن: لا إرسال إيميل بدون طلب صريح وواضح
  return false;
}

// ---------- 6) دالة تجهيز الأقسام الأربعة (Sheets Routing) ----------
// تقبل message كـ object جاهز أو نص JSON يحتاج parse
const SHEET_KEYS = [
  "metadata_context",
  "quantitative_scoring",
  "qualitative_analysis_diagnosis",
  "execution_recommendation",
];

function resolveSheets(messageInput) {
  let messageObj;

  if (typeof messageInput === "string") {
    try {
      messageObj = JSON.parse(messageInput);
    } catch (err) {
      // النص ليس JSON صالحاً — رجّع خطأ واضح بدل تخمين تقسيم خاطئ
      return {
        error: "تعذر تحليل message كـ JSON منظم بالأقسام الأربعة",
        raw_message: messageInput,
      };
    }
  } else if (typeof messageInput === "object" && messageInput !== null) {
    messageObj = messageInput;
  } else {
    return {
      error: "message غير موجود أو بصيغة غير متوقعة",
      raw_message: messageInput,
    };
  }

  const sheets = {};
  const missingKeys = [];

  for (const key of SHEET_KEYS) {
    if (messageObj.hasOwnProperty(key)) {
      sheets[key] = messageObj[key];
    } else {
      sheets[key] = null;
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    sheets._warning = `حقول ناقصة من AI Agent: ${missingKeys.join(", ")}`;
  }

  return sheets;
}

// ---------- 7) نقطة الدخول داخل n8n Code Node ----------

// ملاحظة: عدّل المسار حسب شكل خرج AI Agent node عندك.
const rawOutput = $input.item.json.output ?? $input.item.json.text ?? $input.item.json;
const hasMessageOrEmail =
  $input.item.json.message !== undefined || $input.item.json.send_email !== undefined;

// ===== المسار B: رسالة منظمة (4 فئات) + نية إيميل =====
// يُفعّل هذا المسار إذا كان $json.message أو $json.send_email موجودين في المدخل.
if (hasMessageOrEmail) {
  const sheets = resolveSheets($input.item.json.message);
  const send_email = resolveSendEmail($input.item.json.send_email);

  return [
    {
      json: {
        sheets,
        send_email,
      },
    },
  ];
}

// ===== المسار A: نية حذف (delete_count) =====
let parsed;

try {
  parsed = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
} catch (err) {
  // فشل تحليل JSON من LLM — رجّع خطأ واضح بدل كسر الـ workflow
  return [
    {
      json: {
        action_type: "error",
        error: "فشل تحليل خرج AI Agent كـ JSON",
        raw_output: rawOutput,
      },
    },
  ];
}

if (parsed.action_type !== "delete") {
  // لا توجد نية حذف — مرّر كما هو
  return [{ json: parsed }];
}

const delete_count = resolveDeleteCount(parsed);

const result = {
  action_type: "delete",
  target_decision_id: parsed.target_decision_id ?? null,
  delete_search_term: parsed.delete_search_term ?? null,
  delete_count: delete_count,
};

return [{ json: result }];
