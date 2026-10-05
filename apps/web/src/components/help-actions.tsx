'use client';
import { Button } from '@orvia/ui';

export function HelpActions() {
  return <Button onClick={() => (document.querySelector<HTMLButtonElement>('button[aria-label="Open support chat"]'))?.click()}>Chat with us</Button>;
}
