// Keep the existing Android workflow entry point; Web and native use one guard.
import { checkClientEnvironment } from './check-client-env.mjs';
checkClientEnvironment();
