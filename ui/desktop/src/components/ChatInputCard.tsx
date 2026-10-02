import React from 'react';
import { cn } from '../utils';

/**
 * Shared visual wrapper for the ChatInput.
 *
 * Both the Hub (empty-chat landing) and the BaseChat (active session) present
 * ChatInput as the gm composer card: a white surface with a strong hairline
 * that takes the amber input ring while the message field has focus.
 * Centralizing it here keeps the look in sync.
 */
export const ChatInputCard: React.FC<{
  className?: string;
  children: React.ReactNode;
}> = ({ className, children }) => (
  <div className={cn('gm-composer overflow-hidden', className)}>{children}</div>
);
