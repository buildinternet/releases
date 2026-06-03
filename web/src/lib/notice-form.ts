import { isValidNoticeCoordinate, type Notice } from "@buildinternet/releases-core/notice";

/**
 * Client-side draft state + validation for the entity-notice authoring form.
 * The link target is a single field whose meaning is selected by `linkMode`
 * ("internal" coordinate vs "external" URL), which is what keeps a notice from
 * ever carrying both `coordinate` and `href`. These caps and grammar checks
 * mirror `NoticeSchema` in `@buildinternet/releases-api-types`; the server
 * remains authoritative — this only gives the curator inline feedback.
 */

export type LinkMode = "internal" | "external";

export interface NoticeDraft {
  message: string;
  linkText: string;
  linkMode: LinkMode;
  /** Coordinate ("org" / "org/slug") when internal, else an external URL. */
  linkValue: string;
}

export const NOTICE_MESSAGE_MAX = 280;
export const NOTICE_LINK_TEXT_MAX = 60;
export const NOTICE_HREF_MAX = 500;

export function emptyNoticeDraft(): NoticeDraft {
  return { message: "", linkText: "", linkMode: "internal", linkValue: "" };
}

/** Hydrate the form from an existing notice (or a blank draft when there is none). */
export function draftFromNotice(notice: Notice | null | undefined): NoticeDraft {
  if (!notice) return emptyNoticeDraft();
  return {
    message: notice.message,
    linkText: notice.linkText ?? "",
    linkMode: notice.href ? "external" : "internal",
    linkValue: notice.href ?? notice.coordinate ?? "",
  };
}

export function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Validate a draft and build the `Notice` payload to PATCH, or return a
 * human-readable error for inline display. The link label is only attached when
 * there is a link target to label.
 */
export function buildNoticeFromDraft(draft: NoticeDraft): { notice: Notice } | { error: string } {
  const message = draft.message.trim();
  if (message.length === 0) return { error: "Message is required." };
  if (message.length > NOTICE_MESSAGE_MAX) {
    return { error: `Message must be ${NOTICE_MESSAGE_MAX} characters or fewer.` };
  }

  const notice: Notice = { message };

  const linkValue = draft.linkValue.trim();
  if (linkValue) {
    if (draft.linkMode === "internal") {
      if (!isValidNoticeCoordinate(linkValue)) {
        return { error: 'Coordinate must be "org" or "org/slug".' };
      }
      notice.coordinate = linkValue;
    } else {
      if (!isAbsoluteHttpUrl(linkValue)) {
        return { error: "Link must be an absolute http(s) URL." };
      }
      if (linkValue.length > NOTICE_HREF_MAX) {
        return { error: `Link must be ${NOTICE_HREF_MAX} characters or fewer.` };
      }
      notice.href = linkValue;
    }

    const linkText = draft.linkText.trim();
    if (linkText.length > NOTICE_LINK_TEXT_MAX) {
      return { error: `Link label must be ${NOTICE_LINK_TEXT_MAX} characters or fewer.` };
    }
    if (linkText) notice.linkText = linkText;
  }

  return { notice };
}
