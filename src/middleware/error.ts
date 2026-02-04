import { Context, Next } from 'hono';
import { ZodError } from 'zod';
import { env } from '../env.js';

/**
 * Global error handler middleware
 */
export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    console.error('Error:', error);

    // Determine error details
    let status = 500;
    let message = 'Internal server error';

    // Handle Zod validation errors
    if (error instanceof ZodError) {
      status = 400;
      message = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return c.json({
        success: false,
        error: 'Validation error',
        details: error.errors,
      }, status as any);
    }

    if (error instanceof Error) {
      message = error.message;

      // Parse status from common error patterns
      if (message.includes('not found')) {
        status = 404;
      } else if (message.includes('unauthorized') || message.includes('authentication')) {
        status = 401;
      } else if (message.includes('forbidden') || message.includes('permission')) {
        status = 403;
      } else if (message.includes('invalid') || message.includes('validation')) {
        status = 400;
      }
    }

    // Include stack trace in development
    const response: any = {
      success: false,
      error: message,
    };

    if (env.NODE_ENV === 'development' && error instanceof Error) {
      response.stack = error.stack;
    }

    return c.json(response, status as any);
  }
}
