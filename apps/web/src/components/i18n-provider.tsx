'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { getMessages, type Locale } from '@/i18n';
import type { Messages } from '@/i18n/en';

const MessagesContext = createContext<Messages>(getMessages('en'));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <MessagesContext.Provider value={getMessages(locale)}>{children}</MessagesContext.Provider>
  );
}

export function useMessages(): Messages {
  return useContext(MessagesContext);
}
