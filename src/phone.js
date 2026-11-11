const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "20";

/**
 * Turn a human phone number into a WhatsApp JID.
 * Accepts 01012345678, 201012345678, +20 101 234 5678, 0020...
 */
export function toWhatsAppJid(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  let digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);

  if (digits.startsWith("0")) {
    digits = countryCode + digits.slice(1);
  } else if (digits.length <= 10 && !digits.startsWith(countryCode)) {
    digits = countryCode + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;

  return {
    phone: digits,
    jid: `${digits}@s.whatsapp.net`,
  };
}
