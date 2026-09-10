import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

interface AppErrorBoundaryState {
  error?: Error;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SkyBoard EFB render failure", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="app-error-boundary"><div><TriangleAlert size={34} /><h1>页面渲染失败</h1><p>{this.state.error.message || "发生未知错误"}</p><button className="button primary" onClick={() => window.location.reload()}>重新加载应用</button></div></main>;
  }
}
