import { paid } from '@tollstile/next';
import { toll } from '../../../lib/toll';

export const GET = paid(toll.price('$0.01'), () => Response.json({ city: 'Tokyo', forecast: 'clear' }));
