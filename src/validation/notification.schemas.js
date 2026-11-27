/** zod schemas for notifications (only ids; nothing else comes from the user). */
import { z } from 'zod';

export const notificationIdParams = z.object({ id: z.uuid() });

/** The mark-read forms send only the CSRF token (zod drops unknown keys like _csrf). */
export const emptyBody = z.object({});
