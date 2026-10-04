/**
 * Copy for `/auth/error`, the page Better Auth redirects to when an OAuth
 * callback fails (`onAPIError.errorURL`). The page reads only the `error`
 * code. It does not read `error_description`: that query value is
 * attacker-controlled. Unknown codes — and a missing code — share one
 * generic message so a crafted query string can't write the page.
 */
export type OAuthCallbackErrorCopy = {
  title: string;
  message: string;
};

const GENERIC: OAuthCallbackErrorCopy = {
  title: "Sign-in didn't complete",
  message: "Something went wrong while connecting your account.",
};

const COPY: Record<string, OAuthCallbackErrorCopy> = {
  access_denied: {
    title: "Sign-in was cancelled",
    message: "The sign-in provider closed the request before it finished.",
  },
  state_mismatch: {
    title: "Sign-in couldn't be verified",
    message: "This attempt didn't match the one this browser started.",
  },
  state_security_mismatch: {
    title: "Sign-in couldn't be verified",
    message: "This attempt didn't match the one this browser started.",
  },
  please_restart_the_process: {
    title: "Sign-in couldn't be verified",
    message: "This attempt didn't match the one this browser started.",
  },
  no_code: {
    title: "Sign-in didn't complete",
    message: "The sign-in provider didn't return a confirmation code.",
  },
  invalid_code: {
    title: "Sign-in didn't complete",
    message: "The confirmation code from the sign-in provider was rejected.",
  },
  nonce_binding_missing: {
    title: "Sign-in couldn't be verified",
    message: "The sign-in provider's response was missing a required check.",
  },
  email_not_verified: {
    title: "Email isn't verified",
    message: "The sign-in provider says this email address isn't verified yet.",
  },
  email_not_found: {
    title: "No email on this account",
    message:
      "The sign-in provider didn't share an email address, which Releases needs to create an account.",
  },
  email_does_not_match: {
    title: "Email doesn't match",
    message: "The email from the sign-in provider doesn't match the account you were linking.",
  },
  unable_to_link_account: {
    title: "Couldn't link this account",
    message: "That sign-in method couldn't be connected to your Releases account.",
  },
  account_already_linked_to_different_user: {
    title: "Already linked to another account",
    message: "That sign-in method is already connected to a different Releases account.",
  },
  oauth_provider_not_found: {
    title: "Sign-in isn't available",
    message: "That sign-in method isn't available right now.",
  },
  unable_to_get_user_info: {
    title: "Sign-in didn't complete",
    message: "The sign-in provider didn't return an account profile.",
  },
  issuer_mismatch: {
    title: "Sign-in couldn't be verified",
    message: "The sign-in provider's response didn't come from the expected source.",
  },
  issuer_missing: {
    title: "Sign-in couldn't be verified",
    message: "The sign-in provider's response didn't come from the expected source.",
  },
};

export function oauthCallbackErrorCopy(code: string | undefined): OAuthCallbackErrorCopy {
  if (!code) return GENERIC;
  return COPY[code] ?? GENERIC;
}
