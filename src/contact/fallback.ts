import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export interface FallbackChannel {
    channel: "whatsapp" | "phone" | "none";
    value: string | null;
    note: string;
}

/**
 * Best non-email channel. A WhatsApp link the business publishes on its own
 * site wins; otherwise a listed mobile number becomes a wa.me link; otherwise
 * the listed phone number.
 */
export function fallbackChannel(phone: string | null, countryCode: string, siteWhatsapp: { url: string; page: string } | null): FallbackChannel {
    if (siteWhatsapp) {
        return { channel: "whatsapp", value: siteWhatsapp.url, note: `WhatsApp link published on ${siteWhatsapp.page}` };
    }
    if (!phone) return { channel: "none", value: null, note: "no phone number listed" };

    const parsed = parsePhoneNumberFromString(phone, countryCode as CountryCode);
    if (!parsed || !parsed.isValid()) {
        return { channel: "phone", value: phone, note: "listed number could not be validated for the region" };
    }
    const e164 = parsed.number; // +2348031234567
    const type = parsed.getType();
    if (type === "MOBILE") {
        return {
            channel: "whatsapp",
            value: `https://wa.me/${e164.slice(1)}`,
            note: "built from the listed mobile number; whether it uses WhatsApp is not verified",
        };
    }
    if (type === "FIXED_LINE_OR_MOBILE") {
        return { channel: "phone", value: e164, note: "number type is ambiguous (fixed line or mobile), so no WhatsApp link" };
    }
    return { channel: "phone", value: e164, note: `listed number is ${type ? type.toLowerCase().replace(/_/g, " ") : "not a mobile"}` };
}
