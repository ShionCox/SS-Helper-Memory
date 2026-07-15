export {};

declare global {
  interface Window {
    toastr?: Record<'success' | 'info' | 'warning' | 'error', (...args: unknown[]) => void>;
  }
}
