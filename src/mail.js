const nodemailer = require("nodemailer");
const { getSettings } = require("./db");

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailLogo() {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;background:#ffffff;border:2px solid #ffffff;border-radius:10px">
    <tr><td style="padding:6px">
      <table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse">
        <tr>
          <td width="8" height="8" style="font-size:0;line-height:0">&nbsp;</td>
          <td width="10" height="8" bgcolor="#e30613" style="font-size:0;line-height:0;background:#e30613">&nbsp;</td>
          <td width="8" height="8" style="font-size:0;line-height:0">&nbsp;</td>
        </tr>
        <tr>
          <td width="8" height="10" bgcolor="#e30613" style="font-size:0;line-height:0;background:#e30613">&nbsp;</td>
          <td width="10" height="10" bgcolor="#e30613" style="font-size:0;line-height:0;background:#e30613">&nbsp;</td>
          <td width="8" height="10" bgcolor="#e30613" style="font-size:0;line-height:0;background:#e30613">&nbsp;</td>
        </tr>
        <tr>
          <td width="8" height="8" style="font-size:0;line-height:0">&nbsp;</td>
          <td width="10" height="8" bgcolor="#e30613" style="font-size:0;line-height:0;background:#e30613">&nbsp;</td>
          <td width="8" height="8" style="font-size:0;line-height:0">&nbsp;</td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

function buildShortageMail(check, stationName) {
  const rows = check.shortages
    .map((line, index) => {
      const bg = index % 2 === 0 ? "#ffffff" : "#fff8f8";
      const cell = `padding:10px 8px;background:${bg};border-bottom:1px solid #f6dfe1;font-family:Tahoma,Arial,sans-serif;font-size:14px`;
      let required = String(line.required);
      let actual = String(line.actual);
      let missing = String(line.shortage);
      if (line.type === "interval") {
        required = `كل ${escHtml(line.intervalHours)} ساعة`;
        actual = line.lastChange ? escHtml(new Date(line.lastChange).toLocaleString("en-GB")) : "غير مسجّل";
        missing = "متأخر";
      }
      return `<tr>
        <td style="${cell};text-align:right">
          <div style="font-weight:bold;color:#2a1216">${escHtml(line.nameAr)}</div>
          <div style="color:#8a656a;font-size:12px;margin-top:2px">${escHtml(line.nameEn)}</div>
        </td>
        <td style="${cell};text-align:center;color:#2a1216">${required}</td>
        <td style="${cell};text-align:center;color:#2a1216">${actual}</td>
        <td style="${cell};text-align:center">
          <span style="display:inline-block;background:#fff0f1;color:#b10e18;font-weight:bold;border-radius:999px;padding:4px 10px">${missing}</span>
        </td>
      </tr>`;
    })
    .join("");

  const notes = check.notes
    ? `<tr><td style="padding:4px 16px 8px">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#fff8f8;border:1px solid #f3d5d8;border-radius:12px">
          <tr><td style="padding:12px 14px;font-family:Tahoma,Arial,sans-serif;color:#2a1216">
            <div style="font-size:12px;color:#8a656a;font-weight:bold">ملاحظات · Notes</div>
            <div style="margin-top:4px">${escHtml(check.notes)}</div>
          </td></tr>
        </table>
      </td></tr>`
    : "";

  const text = [
    `نواقص جردة المعدات — ${check.date}`,
    `الاسم: ${stationName}`,
    `المسعف: ${check.paramedicName}`,
    "",
    ...check.shortages.map((line) =>
      line.type === "interval"
        ? `${line.nameAr} (${line.nameEn}): متأخر عن ${line.intervalHours} ساعة. آخر تغيير: ${line.lastChange || "غير مسجّل"}`
        : `${line.nameAr} (${line.nameEn}): المطلوب ${line.required}، الموجود ${line.actual}، النقص ${line.shortage}`
    ),
    check.notes ? `\nملاحظات: ${check.notes}` : "",
  ].join("\n");

  const infoRow = (label, value, ltr) => `<tr>
    <td style="padding:0 0 8px">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#fff8f8" style="background:#fff8f8;border:1px solid #f3d5d8;border-radius:12px">
        <tr>
          <td align="right" style="padding:12px 14px;font-family:Tahoma,Arial,sans-serif;color:#8a656a;font-size:13px">${label}</td>
          <td align="left" dir="${ltr ? "ltr" : "rtl"}" style="padding:12px 14px;font-family:Tahoma,Arial,sans-serif;color:#2a1216;font-weight:bold;font-size:15px;line-height:1.4;${ltr ? "white-space:nowrap" : ""}">${value}</td>
        </tr>
      </table>
    </td>
  </tr>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background:#fff5f6">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#fff5f6" style="background:#fff5f6">
    <tr><td align="center" style="padding:20px 12px">
      <table dir="rtl" width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#ffffff" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #f3d5d8;border-radius:16px">
        <tr><td bgcolor="#e30613" style="background:#e30613;padding:16px 16px 18px;border-radius:16px 16px 0 0">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td width="46" valign="top">${emailLogo()}</td>
              <td valign="middle" align="right" style="padding-right:12px;font-family:Tahoma,Arial,sans-serif;color:#ffffff">
                <div style="font-size:20px;font-weight:bold;line-height:1.35">نواقص جردة المعدات</div>
                <div style="font-size:13px;line-height:1.4;margin-top:4px">Missing supplies from the daily check</div>
                <div style="margin-top:10px">
                  <span style="display:inline-block;background:#ffffff;color:#e30613;border-radius:999px;padding:4px 12px;font-family:Arial,sans-serif;font-weight:bold;font-size:14px">${check.shortages.length} نواقص</span>
                </div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 16px 4px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            ${infoRow("التاريخ · Date", escHtml(check.date), true)}
            ${infoRow("الاسم · Sheet", escHtml(stationName), false)}
            ${infoRow("المسعف · Paramedic", escHtml(check.paramedicName), false)}
          </table>
        </td></tr>
        <tr><td style="padding:8px 16px 8px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border:1px solid #f3d5d8;border-radius:12px">
            <tr bgcolor="#e30613" style="background:#e30613;color:#ffffff;font-family:Tahoma,Arial,sans-serif">
              <th align="right" style="padding:10px 8px;font-size:12px">المادة</th>
              <th align="center" width="54" style="padding:10px 4px;font-size:12px">المطلوب</th>
              <th align="center" width="54" style="padding:10px 4px;font-size:12px">الموجود</th>
              <th align="center" width="54" style="padding:10px 4px;font-size:12px">النقص</th>
            </tr>
            ${rows}
          </table>
        </td></tr>
        ${notes}
        <tr><td style="padding:6px 16px 18px;font-family:Tahoma,Arial,sans-serif;color:#8a656a;font-size:12px;line-height:1.7">
          رسالة آلية من سجل الجردة. لا ترد على هذا البريد إن لم يكن مخصصاً للاستقبال.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: `نواقص الجردة ${check.date} — ${check.shortages.length} (${stationName})`,
    text,
    html,
  };
}

async function sendViaGmailLink(settings, mail) {
  const relay = settings.gmailRelay || {};
  const payload = JSON.stringify({
    secret: relay.secret,
    to: settings.adminEmail,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  const first = await fetch(relay.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: payload,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error("Gmail link did not answer");
    const second = await fetch(location, { signal: AbortSignal.timeout(20000) });
    data = await second.json().catch(() => ({}));
  } else {
    data = await first.json().catch(() => ({}));
  }
  if (!data.ok) throw new Error(data.error || "Gmail link did not accept the message");
}

async function sendShortageEmail(check) {
  if (!check.shortages.length) {
    return { sent: false, skipped: true, reason: "nothing_missing", error: null, to: "" };
  }
  const settings = await getSettings();
  const smtp = settings.smtp || {};
  const relay = settings.gmailRelay || {};
  const relayReady = Boolean(relay.url && relay.secret);
  if (!settings.adminEmail || (!relayReady && (!smtp.host || !smtp.user || !smtp.pass))) {
    return { sent: false, skipped: false, reason: "not_configured", error: null, to: settings.adminEmail || "" };
  }
  const mail = buildShortageMail(check, settings.stationName);
  if (relayReady) {
    try {
      await sendViaGmailLink(settings, mail);
      return { sent: true, skipped: false, reason: "sent", error: null, to: settings.adminEmail, at: new Date().toISOString() };
    } catch (err) {
      return {
        sent: false,
        skipped: false,
        reason: "failed",
        error: String(err.message || "email failed").slice(0, 300),
        to: settings.adminEmail,
      };
    }
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port) || 587,
      secure: Boolean(smtp.secure),
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      await transporter.sendMail({
        from: smtp.from || smtp.user,
        to: settings.adminEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } finally {
      transporter.close();
    }
    return { sent: true, skipped: false, reason: "sent", error: null, to: settings.adminEmail, at: new Date().toISOString() };
  } catch (err) {
    return {
      sent: false,
      skipped: false,
      reason: "failed",
      error: String(err.message || "email failed").slice(0, 300),
      to: settings.adminEmail,
    };
  }
}

module.exports = { buildShortageMail, sendShortageEmail };
