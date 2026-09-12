import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.manatocookietwitterlang.quizmake',
  appName: 'QuizMake',
  webDir: 'dist',
  backgroundColor: '#ffffff',
  loggingBehavior: 'debug',
  zoomEnabled: false,
  ios: {
    contentInset: 'automatic',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
