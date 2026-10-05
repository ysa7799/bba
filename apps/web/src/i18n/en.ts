// English UI messages. Other locales mirror this shape (see `Messages`).
export const en = {
  common: {
    appName: 'BusinessOS',
    loading: 'Loading…',
    retry: 'Try again',
    genericError: 'Something went wrong. Please try again.',
    signOut: 'Sign out',
    back: 'Back',
    next: 'Next page',
  },
  auth: {
    email: 'Work email',
    password: 'Password',
    name: 'Full name',
    login: {
      title: 'Sign in',
      submit: 'Sign in',
      forgot: 'Forgot password?',
      noAccount: 'New to BusinessOS?',
      createAccount: 'Create an account',
      notVerified: 'Please verify your email address first.',
      resend: 'Resend verification email',
      resent: 'If the account needs verification, a new link is on its way.',
    },
    register: {
      title: 'Create your account',
      submit: 'Create account',
      haveAccount: 'Already have an account?',
      passwordHint: 'At least 10 characters.',
    },
    checkEmail: {
      title: 'Check your email',
      body: 'If this address can be used, we have sent a link to {email}. It expires in 24 hours.',
    },
    verify: {
      title: 'Verify your email',
      verifying: 'Verifying your email…',
      success: 'Your email is verified. You can now sign in.',
      continue: 'Continue to sign in',
    },
    forgot: {
      title: 'Reset your password',
      submit: 'Send reset link',
      sent: 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.',
    },
    reset: {
      title: 'Choose a new password',
      submit: 'Update password',
      success: 'Your password has been updated and all other sessions were signed out.',
      newPassword: 'New password',
    },
    invite: {
      title: 'You are invited',
      body: '{inviter} invited {email} to join {organization}.',
      bodyNoInviter: '{email} was invited to join {organization}.',
      accept: 'Join organization',
      createAndJoin: 'Create account and join',
      signInToAccept: 'Sign in as {email} to accept',
      wrongAccount: 'You are signed in as {current}. This invitation is for {email}.',
    },
    missingToken: 'This link is incomplete. Open the link from your email again.',
  },
  onboarding: {
    title: 'Create your organization',
    subtitle: 'You can invite your team once your organization is set up.',
    name: 'Organization name',
    country: 'Country',
    currency: 'Default currency',
    timezone: 'Timezone',
    submit: 'Create organization',
  },
  app: {
    nav: { overview: 'Overview', members: 'Members' },
    switchOrganization: 'Switch organization',
    createOrganization: 'New organization',
    overview: {
      title: 'Overview',
      details: 'Organization details',
      country: 'Country',
      currency: 'Default currency',
      timezone: 'Timezone',
      handle: 'Handle',
    },
    members: {
      title: 'Members',
      search: 'Search members',
      empty: 'No members match your search.',
      name: 'Name',
      email: 'Email',
      status: 'Status',
      joined: 'Joined',
    },
  },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof en>;
