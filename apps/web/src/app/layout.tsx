import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/components/i18n-provider';
import { directionFor, type Locale } from '@/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'BusinessOS', template: '%s · BusinessOS' },
  description: 'Run your business from one place.',
};

// The UI language is English until the Arabic catalogue ships; layout already supports RTL.
const locale: Locale = 'en';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body className="min-h-screen font-sans">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
