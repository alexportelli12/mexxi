import { APP_BASE_HREF } from '@angular/common';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The page has no <base> element: the policy forbids it, so the app says where it lives.
    { provide: APP_BASE_HREF, useValue: '/' },
    provideRouter(routes, withComponentInputBinding()),
  ],
};
