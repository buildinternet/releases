/**
 * Copy for `/auth/error`, the page Better Auth redirects to when a sign-in
 * redirect fails (`onAPIError.errorURL`, `errorCallbackURL`, or a verify
 * link's `?error=`). The page reads only the `error` code. It does not read
 * `error_description`: that query value is attacker-controlled. Unknown
 * codes — and a missing code — share one generic message so a crafted query
 * string can't write the page.
 */
export type OAuthCallbackErrorCopy = {
  title: string;
  message: string;
};

const GENERIC: OAuthCallbackErrorCopy = {
  title: "Sign-in didn't complete",
  message: "Something went wrong while connecting your account.",
};

const STATE: OAuthCallbackErrorCopy = {
  title: "Sign-in couldn't be verified",
  message: "This attempt didn't match the one this browser started.",
};

const CREATE_USER: OAuthCallbackErrorCopy = {
  title: "Couldn't create your account",
  message: "Releases couldn't finish creating an account from that sign-in.",
};

const CREATE_SESSION: OAuthCallbackErrorCopy = {
  title: "Sign-in didn't complete",
  message: "Your account was found, but Releases couldn't start a session.",
};

const INVALID_LINK: OAuthCallbackErrorCopy = {
  title: "This link isn't valid",
  message: "This sign-in link is invalid or has already been used.",
};

const EXPIRED_LINK: OAuthCallbackErrorCopy = {
  title: "This link expired",
  message: "This sign-in link has expired. Request a new one and try again.",
};

const SIGNUP_CLOSED: OAuthCallbackErrorCopy = {
  title: "Sign-up isn't available",
  message: "New accounts can't be created with this sign-in method right now.",
};

const COPY: Record<string, OAuthCallbackErrorCopy> = {
  access_denied: {
    title: "Sign-in was cancelled",
    message: "The sign-in provider closed the request before it finished.",
  },
  state_mismatch: STATE,
  state_security_mismatch: STATE,
  state_not_found: STATE,
  please_restart_the_process: STATE,
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
  unable_to_create_user: CREATE_USER,
  FAILED_TO_CREATE_USER: CREATE_USER,
  failed_to_create_user: CREATE_USER,
  unable_to_create_session: CREATE_SESSION,
  failed_to_create_session: CREATE_SESSION,
  FAILED_TO_CREATE_SESSION: CREATE_SESSION,
  account_not_linked: {
    title: "Couldn't link this account",
    message:
      "An account with that email already exists, but this sign-in method isn't connected to it. Sign in with the method you used before, then connect it from account security.",
  },
  signup_disabled: SIGNUP_CLOSED,
  new_user_signup_disabled: SIGNUP_CLOSED,
  INVALID_TOKEN: INVALID_LINK,
  TOKEN_EXPIRED: EXPIRED_LINK,
  USER_NOT_FOUND: {
    title: "Account not found",
    message: "Releases couldn't find an account for this link.",
  },
  user_not_found: {
    title: "Account not found",
    message: "Releases couldn't find an account for this link.",
  },
  invalid_redirect: {
    title: "Sign-in didn't complete",
    message: "The application that sent you here isn't allowed to finish signing in.",
  },
  invalid_callback_request: GENERIC,
  internal_server_error: GENERIC,
};

export function oauthCallbackErrorCopy(code: string | undefined): OAuthCallbackErrorCopy {
  if (!code) return GENERIC;
  return COPY[code] ?? GENERIC;
}
