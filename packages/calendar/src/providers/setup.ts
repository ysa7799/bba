import { CalendarProviderRegistry } from '../connections';
import { FakeCalendarProvider } from './fake';
import { GoogleCalendarProvider } from './google';
import type { HttpOptions } from './http';
import { MicrosoftCalendarProvider } from './microsoft';

/** Live calendar adapters, plus the in-memory fake in development and tests only. */
export function createCalendarProviders(options: {
  fake: boolean;
  http?: HttpOptions;
}): CalendarProviderRegistry {
  const registry = new CalendarProviderRegistry([
    new GoogleCalendarProvider(options.http),
    new MicrosoftCalendarProvider(options.http),
  ]);
  if (options.fake) registry.register(new FakeCalendarProvider());
  return registry;
}
