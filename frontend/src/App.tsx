import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import {
  AuthProvider,
  useAuth,
} from "./context/AuthContext";

import LoginPage from "./pages/auth/LoginPage";
import SignupPage from "./pages/auth/SignupPage";

import UserDashboard from "./pages/dashboard/UserDashboard";
import AdminDashboard from "./pages/dashboard/AdminDashboard";
import SuperAdminDashboard from "./pages/dashboard/SuperAdminDashboard";
import SubscriptionPage from "./pages/subscriptions/SubscriptionPage";
import WebsiteEditor from "./pages/editor/WebsiteEditor";
import CustomPostTypesList from "./pages/dashboard/CustomPostTypesList";
import CustomPostTypeBuilder from "./pages/dashboard/CustomPostTypeBuilder";
import CustomEntriesList from "./pages/dashboard/CustomEntriesList";
import CustomEntryEditor from "./pages/dashboard/CustomEntryEditor";
import SharedTemplatePreviewPage from "./pages/templates/SharedTemplatePreviewPage";
import WordPressIntegrationPage from "./pages/wordpress/WordPressIntegrationPage";

type UserRole = "USER" | "ADMIN" | "SUPER_ADMIN";

interface RoleRouteProps {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}

function RoleRoute({
  allowedRoles,
  children,
}: RoleRouteProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (user.status !== "ACTIVE") return <Navigate to="/login" replace />;

  if (!allowedRoles.includes(user.role)) {
    switch (user.role) {
      case "SUPER_ADMIN": return <Navigate to="/super-admin" replace />;
      case "ADMIN": return <Navigate to="/admin" replace />;
      case "USER":
      default: return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
}

function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><p className="text-sm text-slate-500">Loading...</p></div>;
  }
  if (user) {
    switch (user.role) {
      case "SUPER_ADMIN": return <Navigate to="/super-admin" replace />;
      case "ADMIN": return <Navigate to="/admin" replace />;
      case "USER":
      default: return <Navigate to="/dashboard" replace />;
    }
  }
  return <LoginPage />;
}

function SignupRoute() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><p className="text-sm text-slate-500">Loading...</p></div>;
  }
  if (user) {
    switch (user.role) {
      case "SUPER_ADMIN": return <Navigate to="/super-admin" replace />;
      case "ADMIN": return <Navigate to="/admin" replace />;
      case "USER":
      default: return <Navigate to="/dashboard" replace />;
    }
  }
  return <SignupPage />;
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50"><p className="text-sm text-slate-500">Loading...</p></div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  switch (user.role) {
    case "SUPER_ADMIN": return <Navigate to="/super-admin" replace />;
    case "ADMIN": return <Navigate to="/admin" replace />;
    case "USER":
    default: return <Navigate to="/dashboard" replace />;
  }
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/signup" element={<SignupRoute />} />
          <Route path="/template/share/:shareToken" element={<SharedTemplatePreviewPage />} />
          <Route path="/" element={<HomeRedirect />} />

          <Route
            path="/dashboard"
            element={<RoleRoute allowedRoles={["USER"]}><UserDashboard /></RoleRoute>}
          />
          <Route
            path="/subscriptions"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><SubscriptionPage /></RoleRoute>}
          />
          <Route
            path="/editor/:websiteId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><WebsiteEditor /></RoleRoute>}
          />
          <Route
            path="/dashboard/wordpress/:websiteId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><WordPressIntegrationPage /></RoleRoute>}
          />

          <Route
            path="/dashboard/cpts/:websiteId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomPostTypesList /></RoleRoute>}
          />
          <Route
            path="/dashboard/cpts/:websiteId/builder"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomPostTypeBuilder /></RoleRoute>}
          />
          <Route
            path="/dashboard/cpts/:websiteId/builder/:cptId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomPostTypeBuilder /></RoleRoute>}
          />
          <Route
            path="/dashboard/cpts/:websiteId/entries/:cptId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomEntriesList /></RoleRoute>}
          />
          <Route
            path="/dashboard/cpts/:websiteId/entries/:cptId/editor"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomEntryEditor /></RoleRoute>}
          />
          <Route
            path="/dashboard/cpts/:websiteId/entries/:cptId/editor/:entryId"
            element={<RoleRoute allowedRoles={["USER", "ADMIN", "SUPER_ADMIN"]}><CustomEntryEditor /></RoleRoute>}
          />

          <Route path="/admin" element={<RoleRoute allowedRoles={["ADMIN"]}><AdminDashboard /></RoleRoute>} />
          <Route path="/super-admin" element={<RoleRoute allowedRoles={["SUPER_ADMIN"]}><SuperAdminDashboard /></RoleRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
