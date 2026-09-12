import { defineConfig } from 'vite'

export default defineConfig({
  base: '/guji-ocr-annotation/',
  build: {
    target: 'es2018',
    cssTarget: 'chrome61',
  },
})
