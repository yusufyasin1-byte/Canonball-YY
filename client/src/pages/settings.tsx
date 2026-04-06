import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { User, UserRole, AuditLog, Idea, PipelineStage } from "@shared/schema";
import { ROLES, PIPELINE_STAGES } from "@shared/schema";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { MetaValidationDashboard } from "@/components/meta-validation-dashboard";
import { PipelineHealthDashboard } from "@/components/pipeline-health-dashboard";
import {
  ShieldAlert,
  Shield,
  Users,
  ScrollText,
  Monitor,
  Search,
  Download,
  ArrowRight,
  CircleDot,
  Brain,
  UserCheck,
  Lightbulb,
  Plug,
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  ExternalLink,
  Clock,
  FolderOpen,
  RefreshCw,
  Stethoscope,
  AlertTriangle,
  Bot,
  Server,
  Play,
  Activity,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  ArrowRightLeft,
  Database,
  Code,
  MessageSquare,
} from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" | "destructive" {
  switch (role) {
    case "Admin":
      return "destructive";
    case "CoE":
      return "default";
    default:
      return "secondary";
  }
}

function UsersTab() {
  const { toast } = useToast();
  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: UserRole }) => {
      await apiRequest("PATCH", `/api/users/${id}`, { role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "Role updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update role", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border overflow-x-auto">
      <Table data-testid="table-users">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users?.map((user) => (
            <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
              <TableCell className="font-medium" data-testid={`text-username-${user.id}`}>
                {user.displayName}
              </TableCell>
              <TableCell className="text-muted-foreground" data-testid={`text-email-${user.id}`}>
                {user.email}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={roleBadgeVariant(user.role)} className="text-xs" data-testid={`badge-role-${user.id}`}>
                    {user.role}
                  </Badge>
                  <Select
                    value={user.role}
                    onValueChange={(value) =>
                      updateRoleMutation.mutate({ id: user.id, role: value as UserRole })
                    }
                    disabled={updateRoleMutation.isPending}
                  >
                    <SelectTrigger
                      className="w-[140px]"
                      data-testid={`select-role-${user.id}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((role) => (
                        <SelectItem key={role} value={role} data-testid={`option-role-${role}`}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {users?.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                No users found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function AuditLogTab() {
  const [filter, setFilter] = useState("");
  const { data: logs, isLoading } = useQuery<AuditLog[]>({
    queryKey: ["/api/audit-logs"],
  });

  const filteredLogs = logs?.filter((log) => {
    if (!filter) return true;
    const term = filter.toLowerCase();
    return (
      log.action.toLowerCase().includes(term) ||
      (log.userName?.toLowerCase().includes(term)) ||
      (log.details?.toLowerCase().includes(term)) ||
      (log.fromStage?.toLowerCase().includes(term)) ||
      (log.toStage?.toLowerCase().includes(term)) ||
      (log.ideaId?.toLowerCase().includes(term))
    );
  });

  const exportCSV = () => {
    if (!filteredLogs?.length) return;
    const headers = ["Timestamp", "User", "Action", "Idea ID", "From Stage", "To Stage", "Details"];
    const rows = filteredLogs.map((log) => [
      new Date(log.createdAt).toISOString(),
      log.userName ?? "",
      log.action,
      log.ideaId ?? "",
      log.fromStage ?? "",
      log.toStage ?? "",
      (log.details ?? "").replace(/"/g, '""'),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search audit logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            data-testid="input-audit-search"
          />
        </div>
        <Button variant="outline" onClick={exportCSV} data-testid="button-export-csv">
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>
      <div className="rounded-md border border-border overflow-x-auto">
        <Table data-testid="table-audit-logs">
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Idea</TableHead>
              <TableHead>Stage Transition</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLogs?.map((log) => (
              <TableRow key={log.id} data-testid={`row-audit-${log.id}`}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(log.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <span className="text-sm">{log.userName ?? "System"}</span>
                  {log.userRole && (
                    <Badge variant="outline" className="ml-2 text-xs">
                      {log.userRole}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {log.action}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground font-mono max-w-[100px] truncate">
                  {log.ideaId ? log.ideaId.slice(0, 8) : "-"}
                </TableCell>
                <TableCell>
                  {log.fromStage || log.toStage ? (
                    <div className="flex items-center gap-1 text-xs flex-wrap">
                      <span className="text-muted-foreground">{log.fromStage ?? "-"}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span>{log.toStage ?? "-"}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                  {log.details ?? "-"}
                </TableCell>
              </TableRow>
            ))}
            {filteredLogs?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No audit log entries found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

interface LlmModelResponse {
  model: string;
  provider: string;
  supportedModels: { id: string; label: string }[];
}

interface LlmCodeModelResponse {
  model: string | null;
  provider: string;
  supportedModels: { id: string; label: string }[];
}

interface LlmMetaValidationModelResponse {
  model: string;
  provider: string;
  supportedModels: { id: string; label: string }[];
}

function SystemTab() {
  const { toast } = useToast();
  const { data: users } = useQuery<User[]>({ queryKey: ["/api/users"] });
  const { data: ideas } = useQuery<Idea[]>({ queryKey: ["/api/ideas"] });
  const { data: llmData, isLoading: llmLoading } = useQuery<LlmModelResponse>({ queryKey: ["/api/settings/llm-model"] });
  const { data: codeModelData, isLoading: codeModelLoading } = useQuery<LlmCodeModelResponse>({ queryKey: ["/api/settings/llm-code-model"] });
  const { data: metaValidationModelData, isLoading: metaValidationModelLoading } = useQuery<LlmMetaValidationModelResponse>({ queryKey: ["/api/settings/llm-meta-validation-model"] });
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [confirmModelOpen, setConfirmModelOpen] = useState(false);
  const [selectedCodeModel, setSelectedCodeModel] = useState<string | null>(null);
  const [confirmCodeModelOpen, setConfirmCodeModelOpen] = useState(false);
  const [selectedMetaValidationModel, setSelectedMetaValidationModel] = useState<string | null>(null);
  const [confirmMetaValidationModelOpen, setConfirmMetaValidationModelOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const updateModelMutation = useMutation({
    mutationFn: async (model: string) => {
      const res = await apiRequest("PUT", "/api/settings/llm-model", { model });
      return res.json();
    },
    onSuccess: (data: LlmModelResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/llm-model"] });
      toast({ title: "Chat model updated", description: `Active chat model changed to ${data.model}` });
      setSelectedModel(null);
      setConfirmModelOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update model", description: err.message, variant: "destructive" });
      setSelectedModel(null);
      setConfirmModelOpen(false);
    },
  });

  const updateCodeModelMutation = useMutation({
    mutationFn: async (model: string | null) => {
      const res = await apiRequest("PUT", "/api/settings/llm-code-model", { model: model || "" });
      return res.json();
    },
    onSuccess: (data: LlmCodeModelResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/llm-code-model"] });
      toast({ title: "Code model updated", description: data.model ? `Code model changed to ${data.model}` : "Code model reset to default (chat model)" });
      setSelectedCodeModel(null);
      setConfirmCodeModelOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update code model", description: err.message, variant: "destructive" });
      setSelectedCodeModel(null);
      setConfirmCodeModelOpen(false);
    },
  });

  const updateMetaValidationModelMutation = useMutation({
    mutationFn: async (model: string) => {
      const res = await apiRequest("PUT", "/api/settings/llm-meta-validation-model", { model });
      return res.json();
    },
    onSuccess: (data: LlmMetaValidationModelResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/llm-meta-validation-model"] });
      toast({ title: "Meta-validation model updated", description: `Meta-validation model changed to ${data.model}` });
      setSelectedMetaValidationModel(null);
      setConfirmMetaValidationModelOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update meta-validation model", description: err.message, variant: "destructive" });
      setSelectedMetaValidationModel(null);
      setConfirmMetaValidationModelOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (ideaId: string) => {
      const res = await apiRequest("DELETE", `/api/ideas/${ideaId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ideas"] });
      toast({ title: "Idea deleted", description: "The idea and all related data have been removed." });
      setConfirmDeleteId(null);
      setDeletingId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setDeletingId(null);
    },
  });

  const stageCounts: Record<string, number> = {};
  PIPELINE_STAGES.forEach((stage) => {
    stageCounts[stage] = 0;
  });
  ideas?.forEach((idea) => {
    if (stageCounts[idea.stage] !== undefined) {
      stageCounts[idea.stage]++;
    }
  });
  const maxCount = Math.max(1, ...Object.values(stageCounts));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 space-y-2" data-testid="card-chat-model">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Brain className="h-4 w-4" />
            Chat Model
          </div>
          {llmLoading ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-semibold" data-testid="text-current-model">
                {llmData?.provider === "anthropic" ? "Anthropic" : llmData?.provider === "openai" ? "OpenAI" : llmData?.provider === "google" ? "Google" : llmData?.provider} {llmData?.model}
              </p>
              <Select
                value={selectedModel || llmData?.model || ""}
                onValueChange={(val) => {
                  if (val !== llmData?.model) {
                    setSelectedModel(val);
                    setConfirmModelOpen(true);
                  }
                }}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="select-chat-model-trigger">
                  <SelectValue placeholder="Change model..." />
                </SelectTrigger>
                <SelectContent>
                  {llmData?.supportedModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} data-testid={`select-chat-model-option-${m.id}`}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <AlertDialog open={confirmModelOpen} onOpenChange={(open) => { setConfirmModelOpen(open); if (!open) setSelectedModel(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change Chat Model?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will change the chat model from <strong>{llmData?.model}</strong> to <strong>{selectedModel}</strong> for conversation and document generation.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-model-change">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => selectedModel && updateModelMutation.mutate(selectedModel)}
                  disabled={updateModelMutation.isPending}
                  data-testid="button-confirm-model-change"
                >
                  {updateModelMutation.isPending ? "Saving..." : "Confirm"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Card>
        <Card className="p-4 space-y-2" data-testid="card-code-model">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Code className="h-4 w-4" />
            Code Model
          </div>
          {codeModelLoading ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-semibold" data-testid="text-current-code-model">
                {codeModelData?.model
                  ? `${codeModelData.provider === "anthropic" ? "Anthropic" : codeModelData.provider === "openai" ? "OpenAI" : codeModelData.provider === "google" ? "Google" : codeModelData.provider} ${codeModelData.model}`
                  : "Using chat model"}
              </p>
              <Select
                value={selectedCodeModel || codeModelData?.model || "__default__"}
                onValueChange={(val) => {
                  const newVal = val === "__default__" ? null : val;
                  const currentVal = codeModelData?.model || null;
                  if (newVal !== currentVal) {
                    setSelectedCodeModel(val === "__default__" ? "__default__" : val);
                    setConfirmCodeModelOpen(true);
                  }
                }}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="select-code-model-trigger">
                  <SelectValue placeholder="(defaults to chat model)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__" data-testid="select-code-model-option-default">
                    (defaults to chat model)
                  </SelectItem>
                  {codeModelData?.supportedModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} data-testid={`select-code-model-option-${m.id}`}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <AlertDialog open={confirmCodeModelOpen} onOpenChange={(open) => { setConfirmCodeModelOpen(open); if (!open) setSelectedCodeModel(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change Code Model?</AlertDialogTitle>
                <AlertDialogDescription>
                  {selectedCodeModel === "__default__"
                    ? <>This will reset the code model to use the chat model for XAML and package generation.</>
                    : <>This will change the code model to <strong>{selectedCodeModel}</strong> for XAML enrichment and UiPath package generation.</>
                  }
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-code-model-change">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (selectedCodeModel === "__default__") {
                      updateCodeModelMutation.mutate(null);
                    } else if (selectedCodeModel) {
                      updateCodeModelMutation.mutate(selectedCodeModel);
                    }
                  }}
                  disabled={updateCodeModelMutation.isPending}
                  data-testid="button-confirm-code-model-change"
                >
                  {updateCodeModelMutation.isPending ? "Saving..." : "Confirm"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Card>
        <Card className="p-4 space-y-2" data-testid="card-meta-validation-model">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Stethoscope className="h-4 w-4" />
            Meta-Validation Model
          </div>
          {metaValidationModelLoading ? (
            <Skeleton className="h-5 w-32" />
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-semibold" data-testid="text-current-meta-validation-model">
                {metaValidationModelData?.provider === "anthropic" ? "Anthropic" : metaValidationModelData?.provider === "openai" ? "OpenAI" : metaValidationModelData?.provider === "google" ? "Google" : metaValidationModelData?.provider} {metaValidationModelData?.model}
              </p>
              <Select
                value={selectedMetaValidationModel || metaValidationModelData?.model || ""}
                onValueChange={(val) => {
                  if (val !== metaValidationModelData?.model) {
                    setSelectedMetaValidationModel(val);
                    setConfirmMetaValidationModelOpen(true);
                  }
                }}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="select-meta-validation-model-trigger">
                  <SelectValue placeholder="Change model..." />
                </SelectTrigger>
                <SelectContent>
                  {metaValidationModelData?.supportedModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} data-testid={`select-meta-validation-model-option-${m.id}`}>
                      {m.label}{m.id === "claude-haiku-4-5" ? " (Recommended)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Controls which AI model reviews generated XAML for errors.</p>
                <p>Fast and cheap (recommended for most processes): Haiku 4.5, Gemini 2.5 Flash, GPT-4o</p>
                <p>More thorough (catches subtler issues, higher cost): Sonnet 4, GPT-5, GPT-5.2, Gemini 2.5 Pro, Opus 4, GPT-5.3 Codex (optimised for code analysis — may catch structural XAML issues other models miss)</p>
              </div>
            </div>
          )}
          <AlertDialog open={confirmMetaValidationModelOpen} onOpenChange={(open) => { setConfirmMetaValidationModelOpen(open); if (!open) setSelectedMetaValidationModel(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change Meta-Validation Model?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will change the meta-validation model from <strong>{metaValidationModelData?.model}</strong> to <strong>{selectedMetaValidationModel}</strong>. More capable models (Sonnet, GPT-5) catch subtler issues but cost more and take longer. Faster models (Haiku, Flash) work well for pattern-matching checks and are more cost-effective.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-meta-validation-model-change">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => selectedMetaValidationModel && updateMetaValidationModelMutation.mutate(selectedMetaValidationModel)}
                  disabled={updateMetaValidationModelMutation.isPending}
                  data-testid="button-confirm-meta-validation-model-change"
                >
                  {updateMetaValidationModelMutation.isPending ? "Saving..." : "Confirm"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </Card>
        <Card className="p-4 space-y-2" data-testid="card-api-status">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <CircleDot className="h-4 w-4" />
            API Status
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            <span className="text-sm font-semibold text-green-500">Connected</span>
          </div>
        </Card>
        <Card className="p-4 space-y-2" data-testid="card-total-users">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <UserCheck className="h-4 w-4" />
            Total Users
          </div>
          <p className="text-2xl font-bold" data-testid="text-user-count">
            {users?.length ?? 0}
          </p>
        </Card>
        <Card className="p-4 space-y-2" data-testid="card-total-ideas">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Lightbulb className="h-4 w-4" />
            Total Ideas
          </div>
          <p className="text-2xl font-bold" data-testid="text-idea-count">
            {ideas?.length ?? 0}
          </p>
        </Card>
      </div>

      <Card className="p-4 space-y-4" data-testid="card-stage-chart">
        <h3 className="text-sm font-semibold text-foreground">Ideas per Stage</h3>
        <div className="space-y-2">
          {PIPELINE_STAGES.map((stage) => {
            const count = stageCounts[stage] ?? 0;
            const pct = (count / maxCount) * 100;
            return (
              <div key={stage} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-[160px] truncate flex-shrink-0" title={stage}>
                  {stage}
                </span>
                <div className="flex-1 h-5 rounded-md bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-md transition-all duration-300"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: "#e8450a",
                      minWidth: count > 0 ? "8px" : "0px",
                    }}
                    data-testid={`bar-stage-${stage}`}
                  />
                </div>
                <span className="text-xs font-mono text-muted-foreground w-6 text-right">{count}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4 space-y-4" data-testid="card-idea-management">
        <h3 className="text-sm font-semibold text-foreground">Idea Management</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ideas?.map((idea) => (
              <TableRow key={idea.id} data-testid={`row-idea-${idea.id}`}>
                <TableCell className="text-sm font-medium">{idea.title}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{idea.owner}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">{idea.stage}</Badge>
                </TableCell>
                <TableCell>
                  {confirmDeleteId === idea.id ? (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs px-2"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          setDeletingId(idea.id);
                          deleteMutation.mutate(idea.id);
                        }}
                        data-testid={`button-confirm-delete-${idea.id}`}
                      >
                        {deletingId === idea.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs px-2"
                        onClick={() => setConfirmDeleteId(null)}
                        data-testid={`button-cancel-delete-${idea.id}`}
                      >
                        No
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirmDeleteId(idea.id)}
                      data-testid={`button-delete-idea-${idea.id}`}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" />
                      Delete
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

type ScopeCategory = {
  category: string;
  service: string;
  scopes: Array<{ id: string; description: string }>;
};

type TaxonomyEntry = {
  flagKey: string;
  displayName: string;
  oauthScopeGroups?: Array<{
    groupLabel: string;
    scopes: Array<{ id: string; description: string }>;
  }>;
};

function deriveScopeCategoriesFromTaxonomy(taxonomy: TaxonomyEntry[]): ScopeCategory[] {
  const categories: ScopeCategory[] = [];
  for (const entry of taxonomy) {
    if (entry.oauthScopeGroups) {
      for (const group of entry.oauthScopeGroups) {
        categories.push({
          category: group.groupLabel,
          service: entry.displayName,
          scopes: group.scopes,
        });
      }
    }
  }
  return categories;
}

function useScopeCategories(): ScopeCategory[] {
  const { data } = useQuery<{ taxonomy: TaxonomyEntry[]; hierarchy: unknown }>({
    queryKey: ["/api/settings/uipath/taxonomy"],
    staleTime: 300000,
    retry: 1,
  });

  const taxonomy = data?.taxonomy;
  if (taxonomy && taxonomy.length > 0) {
    const derived = deriveScopeCategoriesFromTaxonomy(taxonomy);
    if (derived.length > 0) return derived;
  }

  return FALLBACK_SCOPE_CATEGORIES;
}

const FALLBACK_SCOPE_CATEGORIES: ScopeCategory[] = [
  { category: "Orchestrator — Core", service: "Orchestrator", scopes: [
    { id: "OR.Default", description: "General Orchestrator access" },
    { id: "OR.Administration", description: "Administration" },
    { id: "OR.Folders", description: "Full folder access" },
    { id: "OR.Folders.Read", description: "Read folders" },
    { id: "OR.Execution", description: "Full execution access" },
  ]},
  { category: "Orchestrator — Jobs & Robots", service: "Orchestrator", scopes: [
    { id: "OR.Jobs", description: "Full job access" },
    { id: "OR.Jobs.Read", description: "Read jobs" },
    { id: "OR.Jobs.Write", description: "Write jobs" },
    { id: "OR.Robots", description: "Full robot access" },
    { id: "OR.Robots.Read", description: "Read robots" },
    { id: "OR.Machines", description: "Full machine access" },
  ]},
  { category: "Orchestrator — Queues & Assets", service: "Orchestrator", scopes: [
    { id: "OR.Queues", description: "Full queue access" },
    { id: "OR.Queues.Read", description: "Read queues" },
    { id: "OR.Queues.Write", description: "Write queues" },
    { id: "OR.Assets", description: "Full asset access" },
    { id: "OR.Assets.Read", description: "Read assets" },
    { id: "OR.Assets.Write", description: "Write assets" },
  ]},
  { category: "Orchestrator — Action Center & Storage", service: "Orchestrator", scopes: [
    { id: "OR.Tasks", description: "Full task access (Action Center)" },
    { id: "OR.Tasks.Read", description: "Read tasks" },
    { id: "OR.Tasks.Write", description: "Write tasks" },
    { id: "OR.Buckets", description: "Full storage bucket access" },
    { id: "OR.Buckets.Read", description: "Read storage buckets" },
    { id: "OR.Buckets.Write", description: "Write storage buckets" },
    { id: "OR.Triggers", description: "Full trigger access" },
    { id: "OR.Triggers.Read", description: "Read triggers" },
    { id: "OR.Triggers.Write", description: "Write triggers" },
  ]},
  { category: "Orchestrator — Advanced", service: "Orchestrator", scopes: [
    { id: "OR.Administration.Read", description: "Read administration data" },
    { id: "OR.Administration.Write", description: "Write administration data" },
    { id: "OR.Folders.Write", description: "Write folders" },
    { id: "OR.Execution.Read", description: "Read executions" },
    { id: "OR.Execution.Write", description: "Write executions" },
    { id: "OR.Robots.Write", description: "Write robots" },
    { id: "OR.Machines.Read", description: "Read machines" },
    { id: "OR.Machines.Write", description: "Write machines" },
    { id: "OR.Hypervisor", description: "Full hypervisor access" },
    { id: "OR.Hypervisor.Read", description: "Read hypervisor" },
    { id: "OR.Hypervisor.Write", description: "Write hypervisor" },
    { id: "OR.Settings", description: "Full settings access" },
    { id: "OR.Settings.Read", description: "Read settings" },
    { id: "OR.Settings.Write", description: "Write settings" },
    { id: "OR.Users", description: "Full user access" },
    { id: "OR.Users.Read", description: "Read users" },
    { id: "OR.Users.Write", description: "Write users" },
    { id: "OR.License", description: "Full license access" },
    { id: "OR.License.Read", description: "Read licenses" },
    { id: "OR.License.Write", description: "Write licenses" },
    { id: "OR.Monitoring", description: "Full monitoring access" },
    { id: "OR.Monitoring.Read", description: "Read monitoring" },
    { id: "OR.Monitoring.Write", description: "Write monitoring" },
    { id: "OR.Analytics", description: "Full analytics access" },
    { id: "OR.Analytics.Read", description: "Read analytics" },
    { id: "OR.Analytics.Write", description: "Write analytics" },
    { id: "OR.Audit", description: "Full audit access" },
    { id: "OR.Audit.Read", description: "Read audit logs" },
    { id: "OR.Audit.Write", description: "Write audit logs" },
    { id: "OR.Webhooks", description: "Full webhook access" },
    { id: "OR.Webhooks.Read", description: "Read webhooks" },
    { id: "OR.Webhooks.Write", description: "Write webhooks" },
    { id: "OR.ML", description: "Full ML access" },
    { id: "OR.ML.Read", description: "Read ML models" },
    { id: "OR.ML.Write", description: "Write ML models" },
    { id: "OR.BackgroundTasks", description: "Full background task access" },
    { id: "OR.BackgroundTasks.Read", description: "Read background tasks" },
    { id: "OR.BackgroundTasks.Write", description: "Write background tasks" },
    { id: "OR.TestSets", description: "Full test set access" },
    { id: "OR.TestSets.Read", description: "Read test sets" },
    { id: "OR.TestSets.Write", description: "Write test sets" },
    { id: "OR.TestSetExecutions", description: "Full test execution access" },
    { id: "OR.TestSetExecutions.Read", description: "Read test executions" },
    { id: "OR.TestSetExecutions.Write", description: "Write test executions" },
    { id: "OR.TestSetSchedules", description: "Full test schedule access" },
    { id: "OR.TestSetSchedules.Read", description: "Read test schedules" },
    { id: "OR.TestSetSchedules.Write", description: "Write test schedules" },
    { id: "OR.TestDataQueues", description: "Full test data queue access" },
    { id: "OR.TestDataQueues.Read", description: "Read test data queues" },
    { id: "OR.TestDataQueues.Write", description: "Write test data queues" },
    { id: "OR.AutomationSolutions.Access", description: "Automation Solutions access" },
    { id: "AutomationSolutions", description: "Native Solutions Management access" },
    { id: "Solutions.Packages", description: "Full solution package access" },
    { id: "Solutions.Packages.Read", description: "Read solution packages" },
    { id: "Solutions.Packages.Write", description: "Write solution packages" },
    { id: "Solutions.Deployments", description: "Full solution deployment access" },
    { id: "Solutions.Deployments.Read", description: "Read solution deployments" },
    { id: "Solutions.Deployments.Write", description: "Write solution deployments" },
    { id: "OR.Processes", description: "Full process access" },
  ]},
  { category: "Test Manager", service: "Test Manager", scopes: [
    { id: "TM.TestCases", description: "Full test case access" },
    { id: "TM.TestCases.Read", description: "Read test cases" },
    { id: "TM.TestCases.Write", description: "Write test cases" },
    { id: "TM.TestSets", description: "Full test set access" },
    { id: "TM.TestSets.Read", description: "Read test sets" },
    { id: "TM.TestSets.Write", description: "Write test sets" },
    { id: "TM.TestExecutions", description: "Full test execution access" },
    { id: "TM.TestExecutions.Read", description: "Read test executions" },
    { id: "TM.Requirements", description: "Full requirements access" },
    { id: "TM.Projects", description: "Full project access" },
    { id: "TM.Projects.Read", description: "Read projects" },
    { id: "TM.Users.Read", description: "Read users" },
  ]},
  { category: "Document Understanding", service: "Document Understanding", scopes: [
    { id: "Du.Classification.Api", description: "Document classification" },
    { id: "Du.Digitization.Api", description: "Document digitization (OCR)" },
    { id: "Du.Extraction.Api", description: "Document data extraction" },
    { id: "Du.Validation.Api", description: "Document validation" },
    { id: "Du.DocumentManager.Document", description: "Document manager access" },
    { id: "Du.DataDeletion.Api", description: "Data deletion" },
  ]},
  { category: "Data Service", service: "Data Service", scopes: [
    { id: "DataFabric.Schema.Read", description: "Read data schemas" },
    { id: "DataFabric.Data.Read", description: "Read data entities" },
    { id: "DataFabric.Data.Write", description: "Write data entities" },
  ]},
  { category: "Maestro", service: "Maestro", scopes: [
    { id: "PIMS.Default", description: "General Maestro access" },
    { id: "PIMS.Read", description: "Read Maestro data" },
    { id: "PIMS.Write", description: "Write Maestro data" },
    { id: "PIMS.Process", description: "Full process access" },
    { id: "PIMS.Process.Read", description: "Read processes" },
    { id: "PIMS.Process.Write", description: "Write processes" },
    { id: "PIMS.Execution", description: "Full execution access" },
    { id: "PIMS.Execution.Read", description: "Read executions" },
  ]},
  { category: "AI Center", service: "AI Center", scopes: [
    { id: "AI.Deployer.Read", description: "Read AI deployments and skills" },
    { id: "AI.Deployer.Write", description: "Write AI deployments and skills" },
    { id: "AI.Trainer.Read", description: "Read AI training pipelines" },
    { id: "AI.Trainer.Write", description: "Write AI training pipelines" },
    { id: "AI.Helper.Read", description: "Read AI helper data" },
  ]},
  { category: "Platform Management", service: "Platform Management", scopes: [
    { id: "PM.Security", description: "Security settings" },
    { id: "PM.AuthSetting", description: "Auth settings" },
    { id: "PM.OAuthApp", description: "OAuth application management" },
    { id: "PM.RobotAccount", description: "Robot account access" },
    { id: "PM.RobotAccount.Read", description: "Read robot accounts" },
    { id: "PM.RobotAccount.Write", description: "Write robot accounts" },
  ]},
  { category: "IXP / Communications Mining", service: "IXP Platform", scopes: [
    { id: "Ixp.ApiAccess", description: "IXP API access (Generative Extraction, Communications Mining)" },
  ]},
];

function extractOrgSlug(input: string): string {
  let val = input.trim();
  val = val.replace(/^https?:\/\//, "");
  val = val.replace(/^cloud\.uipath\.com\//, "");
  val = val.replace(/\/+$/, "");
  val = val.split("/")[0];
  return val.trim();
}

function OrchestratorHealthPanel() {
  const [diagExpanded, setDiagExpanded] = useState(false);
  const [machinesOpen, setMachinesOpen] = useState(false);
  const [robotsOpen, setRobotsOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [attendedOpen, setAttendedOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);

  const { data: diagnostics, isLoading: diagLoading, refetch: refetchDiag } = useQuery<{
    configured: boolean;
    connected: boolean;
    tenantName?: string;
    latencyMs?: number;
    checks: Array<{ name: string; status: string; detail: string; remediation?: string }>;
    serviceDetails?: Record<string, { status: string; confidence: string; evidence: string; reachable: string }>;
  }>({
    queryKey: ["/api/uipath/diagnostics"],
    enabled: false,
  });

  const { data: liveOps } = useQuery<{
    connected: boolean;
    message?: string;
    latencyMs?: number;
    tenantName?: string;
    folderName?: string;
    activeJobs?: number;
    pendingTasks?: number;
    processCount?: number;
    machineCount?: number;
    robotCount?: number;
    queueCount?: number;
    lastProvisioningDecision?: any;
  }>({
    queryKey: ["/api/uipath/live-ops"],
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const { data: healthData } = useQuery<{
    ok: boolean;
    message: string;
    latencyMs: number;
    tenantName?: string;
  }>({
    queryKey: ["/api/uipath/health"],
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const { data: machinesData, isLoading: machinesLoading, refetch: refetchMachines } = useQuery<{
    success: boolean;
    machines?: Array<{ id: number; name: string; type: string; status: string; description: string }>;
  }>({
    queryKey: ["/api/settings/uipath/machines"],
    enabled: false,
  });

  const { data: robotsData, isLoading: robotsLoading, refetch: refetchRobots } = useQuery<{
    success: boolean;
    robots?: Array<{ id: number; robotId: number; robotName: string; machineName: string; status: string; type: string; isUnresponsive: boolean }>;
  }>({
    queryKey: ["/api/settings/uipath/robots"],
    enabled: false,
  });

  const { data: processesData, isLoading: processesLoading, refetch: refetchProcesses } = useQuery<{
    success: boolean;
    processes?: Array<{ id: number; name: string; processKey: string; processVersion: string; description: string }>;
  }>({
    queryKey: ["/api/settings/uipath/processes"],
    enabled: false,
  });

  const { data: governanceData, isLoading: governanceLoading, refetch: refetchGovernance } = useQuery<{
    available: boolean;
    policies: Array<{ id: string; name: string; description: string; type: string; severity: string; restrictedActivities?: string[] }>;
    message: string;
  }>({
    queryKey: ["/api/settings/uipath/governance-policies"],
    enabled: false,
  });

  const { data: attendedData, isLoading: attendedLoading, refetch: refetchAttended } = useQuery<{
    available: boolean;
    attendedRobots: Array<{ id: number; name: string; machineName: string; status: string; userName?: string }>;
    unattendedRobots: Array<{ id: number; name: string; machineName: string; status: string }>;
    hasAttended: boolean;
    hasUnattended: boolean;
    message: string;
  }>({
    queryKey: ["/api/settings/uipath/attended-robots"],
    enabled: false,
  });

  const { data: studioData, isLoading: studioLoading, refetch: refetchStudio } = useQuery<{
    available: boolean;
    projects: Array<{ id: string; name: string; description: string; projectType: string }>;
    existingNames: string[];
    message: string;
  }>({
    queryKey: ["/api/settings/uipath/studio-projects"],
    enabled: false,
  });

  const runDiagnostics = () => {
    setDiagExpanded(true);
    refetchDiag();
    refetchMachines();
    refetchRobots();
    refetchProcesses();
    refetchGovernance();
    refetchAttended();
    refetchStudio();
  };

  const statusIcon = (status: string) => {
    if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
    if (status === "blocking") return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
    return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  };

  const statusColor = (status: string) => {
    if (status === "pass") return "border-green-600/30 bg-green-500/10";
    if (status === "blocking") return "border-red-600/30 bg-red-500/10";
    return "border-amber-500/30 bg-amber-500/10";
  };

  const latencyDot = (ms: number) => {
    if (ms < 200) return "bg-green-500";
    if (ms < 500) return "bg-amber-500";
    return "bg-red-500";
  };

  const isConnected = healthData?.ok ?? liveOps?.connected ?? false;

  return (
    <div className="border-t border-border pt-4 mt-4 space-y-4" data-testid="health-check-section">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-2.5 w-2.5 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`} />
          <h4 className="text-sm font-semibold text-foreground">
            {isConnected ? `Connected to ${healthData?.tenantName || liveOps?.tenantName || "Orchestrator"}` : "Disconnected"}
          </h4>
          {healthData && (
            <span className="text-[10px] text-muted-foreground">
              {healthData.latencyMs}ms
            </span>
          )}
        </div>
        <Badge
          variant={isConnected ? "default" : "destructive"}
          className="text-[10px]"
          data-testid="badge-connection-status"
        >
          {isConnected ? "Connected" : "Disconnected"}
        </Badge>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-[#e8450a]" />
          <h4 className="text-sm font-semibold text-foreground">Orchestrator Diagnostics</h4>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={runDiagnostics}
          disabled={diagLoading}
          data-testid="button-run-diagnostics"
        >
          {diagLoading ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Checking...
            </>
          ) : (
            <>
              <Activity className="mr-1.5 h-3.5 w-3.5" />
              Run Diagnostics
            </>
          )}
        </Button>
      </div>

      {diagExpanded && diagnostics && (
        <div className="space-y-2" data-testid="diagnostics-checklist">
          {diagnostics.checks.map((check) => (
            <div
              key={`diag-${check.name}`}
              className={`flex items-start gap-2.5 p-2.5 rounded-md border ${statusColor(check.status)}`}
              data-testid={`diag-check-${check.name.toLowerCase().replace(/\s/g, "-")}`}
            >
              {statusIcon(check.status)}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-semibold text-foreground">{check.name}</p>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{check.detail}</p>
                {check.remediation && check.status !== "pass" && (
                  <p className="text-xs text-amber-400 mt-1">→ {check.remediation}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {diagExpanded && diagnostics?.serviceDetails && Object.keys(diagnostics.serviceDetails).length > 0 && (
        <div className="space-y-2" data-testid="service-details-grid">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Service Availability</h4>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(diagnostics.serviceDetails).map(([name, detail]) => {
              const statusDot = detail.status === "available" ? "bg-green-500"
                : detail.status === "limited" ? "bg-amber-500"
                : detail.status === "unavailable" ? "bg-red-500"
                : "bg-gray-400";
              const confLabel = detail.confidence === "inferred" ? " (inferred)" : detail.confidence === "deprecated" ? " (deprecated)" : "";
              return (
                <div
                  key={name}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] border border-border/50 bg-muted/30"
                  title={`${detail.evidence} | reachable: ${detail.reachable}`}
                  data-testid={`service-detail-${name}`}
                >
                  <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot}`} />
                  <span className="text-foreground truncate">{name}{confLabel}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {diagExpanded && (
        <div className="space-y-2">
          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setProcessesOpen(!processesOpen); if (!processesData) refetchProcesses(); }}
            aria-expanded={processesOpen}
            aria-controls="processes-list-panel"
            data-testid="toggle-processes-list"
          >
            {processesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Play className="h-3.5 w-3.5 text-[#e8450a]" />
            Processes ({processesData?.processes?.length ?? "..."})
          </button>
          {processesOpen && (
            <div id="processes-list-panel" className="ml-6 space-y-1" data-testid="processes-list">
              {processesLoading && <Skeleton className="h-8 w-full" />}
              {processesData?.processes?.length === 0 && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No processes found in this folder.
                </p>
              )}
              {processesData?.processes?.map((proc) => (
                <div key={proc.id} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-process-${proc.id}`}>
                  <div>
                    <span className="font-medium text-foreground">{proc.name}</span>
                    <span className="ml-2 text-muted-foreground">v{proc.processVersion}</span>
                  </div>
                  <code className="text-[10px] text-muted-foreground">{proc.processKey}</code>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setRobotsOpen(!robotsOpen); if (!robotsData) refetchRobots(); }}
            aria-expanded={robotsOpen}
            aria-controls="robots-list-panel"
            data-testid="toggle-robots-list"
          >
            {robotsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Bot className="h-3.5 w-3.5 text-[#008b9b]" />
            Robots ({robotsData?.robots?.length ?? "..."})
          </button>
          {robotsOpen && (
            <div id="robots-list-panel" className="ml-6 space-y-1" data-testid="robots-list">
              {robotsLoading && <Skeleton className="h-8 w-full" />}
              {robotsData?.robots?.length === 0 && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No robot sessions found.
                </p>
              )}
              {robotsData?.robots?.map((robot) => (
                <div key={robot.id} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-robot-${robot.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{robot.robotName}</span>
                    <Badge variant={robot.status === "Available" ? "default" : "secondary"} className="text-[10px] py-0">
                      {robot.status}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">{robot.machineName}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setMachinesOpen(!machinesOpen); if (!machinesData) refetchMachines(); }}
            aria-expanded={machinesOpen}
            aria-controls="machines-list-panel"
            data-testid="toggle-machines-list"
          >
            {machinesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Server className="h-3.5 w-3.5 text-[#7b1fa2]" />
            Machines ({machinesData?.machines?.length ?? "..."})
          </button>
          {machinesOpen && (
            <div id="machines-list-panel" className="ml-6 space-y-1" data-testid="machines-list">
              {machinesLoading && <Skeleton className="h-8 w-full" />}
              {machinesData?.machines?.length === 0 && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No machine templates found.
                </p>
              )}
              {machinesData?.machines?.map((machine) => (
                <div key={machine.id} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-machine-${machine.id}`}>
                  <span className="font-medium text-foreground">{machine.name}</span>
                  <span className="text-muted-foreground">{machine.type || "Standard"}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setGovernanceOpen(!governanceOpen); if (!governanceData) refetchGovernance(); }}
            aria-expanded={governanceOpen}
            aria-controls="governance-list-panel"
            data-testid="toggle-governance-list"
          >
            {governanceOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <ShieldAlert className="h-3.5 w-3.5 text-[#e65100]" />
            Governance Policies ({governanceData?.policies?.length ?? "..."})
          </button>
          {governanceOpen && (
            <div id="governance-list-panel" className="ml-6 space-y-1" data-testid="governance-list">
              {governanceLoading && <Skeleton className="h-8 w-full" />}
              {governanceData && !governanceData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  {governanceData.message || "Automation Ops not available on this tenant."}
                </p>
              )}
              {governanceData?.policies?.length === 0 && governanceData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No active governance policies found.
                </p>
              )}
              {governanceData?.policies?.map((policy, pi) => (
                <div key={`gov-${policy.id}-${pi}`} className="p-2 rounded bg-card border border-border text-xs" data-testid={`row-policy-${policy.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{policy.name}</span>
                    <Badge variant={policy.severity === "error" ? "destructive" : policy.severity === "warning" ? "secondary" : "outline"} className="text-[10px] py-0">
                      {policy.severity}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] py-0">
                      {policy.type}
                    </Badge>
                  </div>
                  {policy.description && <p className="text-muted-foreground mt-1">{policy.description}</p>}
                  {policy.restrictedActivities && policy.restrictedActivities.length > 0 && (
                    <p className="text-amber-400 mt-1">Restricted: {policy.restrictedActivities.join(", ")}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setAttendedOpen(!attendedOpen); if (!attendedData) refetchAttended(); }}
            aria-expanded={attendedOpen}
            aria-controls="attended-list-panel"
            data-testid="toggle-attended-list"
          >
            {attendedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Monitor className="h-3.5 w-3.5 text-[#2e7d32]" />
            Attended / Assistant ({attendedData ? `${attendedData.attendedRobots?.length ?? 0} attended, ${attendedData.unattendedRobots?.length ?? 0} unattended` : "..."})
          </button>
          {attendedOpen && (
            <div id="attended-list-panel" className="ml-6 space-y-1" data-testid="attended-list">
              {attendedLoading && <Skeleton className="h-8 w-full" />}
              {attendedData && !attendedData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  {attendedData.message || "Robot session discovery not available."}
                </p>
              )}
              {attendedData?.attendedRobots?.length === 0 && attendedData?.unattendedRobots?.length === 0 && attendedData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No active robot sessions found.
                </p>
              )}
              {attendedData?.attendedRobots?.map((robot, ri) => (
                <div key={`attended-${robot.id}-${ri}`} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-attended-${robot.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{robot.name}</span>
                    <Badge variant="default" className="text-[10px] py-0 bg-green-600">Attended</Badge>
                    <Badge variant={robot.status === "Available" ? "default" : "secondary"} className="text-[10px] py-0">
                      {robot.status}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">{robot.machineName}{robot.userName ? ` (${robot.userName})` : ""}</span>
                </div>
              ))}
              {attendedData?.unattendedRobots?.map((robot, ri) => (
                <div key={`unattended-${robot.id}-${ri}`} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-unattended-${robot.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{robot.name}</span>
                    <Badge variant="secondary" className="text-[10px] py-0">Unattended</Badge>
                    <Badge variant={robot.status === "Available" ? "default" : "secondary"} className="text-[10px] py-0">
                      {robot.status}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">{robot.machineName}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors w-full"
            onClick={() => { setStudioOpen(!studioOpen); if (!studioData) refetchStudio(); }}
            aria-expanded={studioOpen}
            aria-controls="studio-list-panel"
            data-testid="toggle-studio-list"
          >
            {studioOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <FolderOpen className="h-3.5 w-3.5 text-[#1565c0]" />
            Studio Projects ({studioData?.projects?.length ?? "..."})
          </button>
          {studioOpen && (
            <div id="studio-list-panel" className="ml-6 space-y-1" data-testid="studio-list">
              {studioLoading && <Skeleton className="h-8 w-full" />}
              {studioData && !studioData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  {studioData.message || "Studio project discovery not available."}
                </p>
              )}
              {studioData?.projects?.length === 0 && studioData.available && (
                <p className="text-xs text-muted-foreground p-2 border border-dashed border-border rounded">
                  No existing projects found.
                </p>
              )}
              {studioData?.projects?.map((project, pi) => (
                <div key={`studio-${project.id}-${pi}`} className="flex items-center justify-between p-2 rounded bg-card border border-border text-xs" data-testid={`row-studio-${project.id}`}>
                  <div>
                    <span className="font-medium text-foreground">{project.name}</span>
                    <Badge variant="outline" className="ml-2 text-[10px] py-0">{project.projectType}</Badge>
                  </div>
                  {project.description && <span className="text-muted-foreground max-w-[200px] truncate">{project.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border pt-3 mt-3" data-testid="live-ops-section">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-[#008b9b]" />
          <h4 className="text-sm font-semibold text-foreground">Live Operations</h4>
          <span className="text-[10px] text-muted-foreground">Auto-refreshes every 30s</span>
        </div>

        {!isConnected ? (
          <div className="p-3 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-400" data-testid="live-ops-disconnected">
            <p className="font-medium">Live Operations unavailable</p>
            <p className="mt-1 text-amber-400/80">
              CannonBall cannot reach UiPath Orchestrator. Check credentials or network connectivity.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => refetchDiag()}
              data-testid="button-retry-connection"
            >
              <RefreshCw className="mr-1.5 h-3 w-3" />
              Retry Connection
            </Button>
          </div>
        ) : liveOps ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="live-ops-metrics">
            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-latency">
              <p className="text-muted-foreground mb-1">Connection Latency</p>
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${latencyDot(liveOps.latencyMs || 0)}`} />
                <span className="font-semibold text-foreground">{liveOps.latencyMs || 0}ms</span>
              </div>
            </div>

            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-active-jobs">
              <p className="text-muted-foreground mb-1">Active Jobs</p>
              <span className="font-semibold text-foreground">{liveOps.activeJobs ?? 0} running</span>
            </div>

            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-pending-tasks">
              <p className="text-muted-foreground mb-1">Action Center</p>
              <span className="font-semibold text-foreground">{liveOps.pendingTasks ?? 0} pending</span>
            </div>

            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-processes">
              <p className="text-muted-foreground mb-1">Processes</p>
              <span className="font-semibold text-foreground">{liveOps.processCount ?? 0}</span>
            </div>

            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-machines">
              <p className="text-muted-foreground mb-1">Machines</p>
              <span className="font-semibold text-foreground">{liveOps.machineCount ?? 0}</span>
            </div>

            <div className="p-2.5 rounded-md border border-border bg-card text-xs" data-testid="metric-queues">
              <p className="text-muted-foreground mb-1">Queues</p>
              <span className="font-semibold text-foreground">{liveOps.queueCount ?? 0}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading live operations data...
          </div>
        )}
      </div>
    </div>
  );
}

type UipathConnection = {
  id: number;
  name: string;
  orgName: string;
  tenantName: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  folderId: string | null;
  folderName: string | null;
  automationHubToken: string | null;
  communicationsMiningToken: string | null;
  isActive: boolean;
  lastTestedAt: string | null;
  createdAt: string;
};

function ConnectionManagerPanel({ onEditConnection }: { onEditConnection: (conn: UipathConnection) => void }) {
  const { toast } = useToast();

  const { data: connections, isLoading } = useQuery<UipathConnection[]>({
    queryKey: ["/api/settings/uipath/connections"],
  });

  const activateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/settings/uipath/connections/${id}/activate`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath"] });
      toast({ title: "Connection switched", description: "Active orchestrator updated. All tokens have been refreshed." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to switch", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/settings/uipath/connections/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath/connections"] });
      toast({ title: "Connection deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/settings/uipath/connections/${id}/test`);
      return res.json();
    },
    onSuccess: (data: { success: boolean; message: string }, id: number) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath/connections"] });
      if (data.success) {
        toast({ title: "Connection test passed", description: data.message });
      } else {
        toast({ title: "Connection test failed", description: data.message, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Test failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!connections || connections.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground" data-testid="no-connections">
        <Database className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p>No orchestrator connections configured yet.</p>
        <p className="text-xs mt-1">Use the wizard below to add your first connection.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="connections-list">
      {connections.map((conn) => (
        <div
          key={conn.id}
          className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
            conn.isActive
              ? "border-green-600/50 bg-green-500/5"
              : "border-border bg-card hover:bg-muted/30"
          }`}
          data-testid={`connection-card-${conn.id}`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-foreground truncate" data-testid={`connection-name-${conn.id}`}>
                {conn.name}
              </span>
              {conn.isActive ? (
                <Badge variant="outline" className="border-green-600 text-green-500 text-[10px] px-1.5 py-0" data-testid={`badge-active-${conn.id}`}>
                  Active
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground text-[10px] px-1.5 py-0" data-testid={`badge-inactive-${conn.id}`}>
                  Inactive
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
              <span>{conn.orgName} / {conn.tenantName}</span>
              {conn.lastTestedAt && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Tested {new Date(conn.lastTestedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => testMutation.mutate(conn.id)}
              disabled={testMutation.isPending}
              title="Test connection"
              data-testid={`button-test-connection-${conn.id}`}
            >
              {testMutation.isPending && testMutation.variables === conn.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEditConnection(conn)}
              title="Edit connection"
              data-testid={`button-edit-connection-${conn.id}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {!conn.isActive && (
              <>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-[#e8450a]"
                      title="Switch to this connection"
                      data-testid={`button-switch-connection-${conn.id}`}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Switch Active Connection</AlertDialogTitle>
                      <AlertDialogDescription>
                        Switch to <strong>{conn.name}</strong> ({conn.orgName}/{conn.tenantName})? All cached tokens will be invalidated and the system will reconnect using this connection's credentials.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => activateMutation.mutate(conn.id)}
                        data-testid={`confirm-switch-${conn.id}`}
                      >
                        Switch
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      title="Delete connection"
                      data-testid={`button-delete-connection-${conn.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Connection</AlertDialogTitle>
                      <AlertDialogDescription>
                        Delete <strong>{conn.name}</strong>? This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteMutation.mutate(conn.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        data-testid={`confirm-delete-${conn.id}`}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function IntegrationServicePanel() {
  const { data: discovery, isLoading, refetch } = useQuery<{
    available: boolean;
    connectors: Array<{ id: string; name: string; description?: string; provider?: string; connectionCount: number }>;
    connections: Array<{ id: string; connectorId: string; connectorName: string; name: string; status: string; createdAt?: string; provider?: string }>;
    summary: string;
  }>({
    queryKey: ["/api/uipath/integration-service"],
    staleTime: 60000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/uipath/integration-service/refresh");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/uipath/integration-service"] });
    },
  });

  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <Card className="p-4 mt-4 space-y-3" data-testid="card-integration-service-loading">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
      </Card>
    );
  }

  if (!discovery) return null;

  const activeConnections = discovery.connections.filter(
    c => c.status.toLowerCase() === "connected" || c.status.toLowerCase() === "active"
  );

  return (
    <Card className="p-4 mt-4 space-y-3" data-testid="card-integration-service">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Integration Service</h3>
          {discovery.available ? (
            <Badge variant="outline" className="text-[10px] border-green-600/30 bg-green-500/10 text-green-400" data-testid="badge-is-status">
              Available
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-400" data-testid="badge-is-status">
              Unavailable
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              refreshMutation.mutate();
            }}
            disabled={refreshMutation.isPending}
            data-testid="button-refresh-is"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refreshMutation.isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1"
            onClick={() => setExpanded(!expanded)}
            data-testid="button-expand-is"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="text-is-summary">
        {discovery.summary}
      </p>

      {activeConnections.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {activeConnections.map(conn => (
            <Badge
              key={conn.id}
              variant="outline"
              className="text-[10px] border-green-600/30 bg-green-500/10 text-green-400"
              data-testid={`badge-is-connection-${conn.id}`}
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              {conn.connectorName}: {conn.name}
            </Badge>
          ))}
        </div>
      )}

      {expanded && (
        <div className="space-y-3 pt-2 border-t border-border">
          {discovery.connections.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-foreground mb-2">Connections ({discovery.connections.length})</h4>
              <div className="space-y-1.5">
                {discovery.connections.map(conn => (
                  <div
                    key={conn.id}
                    className={`flex items-center justify-between px-3 py-2 rounded-md border text-xs ${
                      conn.status.toLowerCase() === "connected" || conn.status.toLowerCase() === "active"
                        ? "border-green-600/30 bg-green-500/5"
                        : "border-border bg-muted/30"
                    }`}
                    data-testid={`row-is-connection-${conn.id}`}
                  >
                    <div className="flex items-center gap-2">
                      {conn.status.toLowerCase() === "connected" || conn.status.toLowerCase() === "active" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <div>
                        <span className="font-medium text-foreground">{conn.connectorName}</span>
                        <span className="text-muted-foreground ml-1.5">{conn.name}</span>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        conn.status.toLowerCase() === "connected" || conn.status.toLowerCase() === "active"
                          ? "border-green-600/30 text-green-400"
                          : "border-muted text-muted-foreground"
                      }`}
                    >
                      {conn.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {discovery.connectors.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-foreground mb-2">Available Connectors ({discovery.connectors.length})</h4>
              <div className="flex flex-wrap gap-1.5">
                {discovery.connectors.slice(0, 30).map(conn => (
                  <Badge
                    key={conn.id}
                    variant="outline"
                    className="text-[10px]"
                    data-testid={`badge-is-connector-${conn.id}`}
                  >
                    {conn.name}
                    {conn.connectionCount > 0 && (
                      <span className="ml-1 text-green-400">({conn.connectionCount})</span>
                    )}
                  </Badge>
                ))}
                {discovery.connectors.length > 30 && (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    +{discovery.connectors.length - 30} more
                  </Badge>
                )}
              </div>
            </div>
          )}

          {discovery.connections.length === 0 && discovery.connectors.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No connectors or connections discovered. Configure Integration Service in UiPath to enable pre-built enterprise system integrations.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function AutomationHubPanel() {
  const { toast } = useToast();
  const [hubToken, setHubToken] = useState("");
  const [showHubToken, setShowHubToken] = useState(false);

  const { data: hubStatus, isLoading: hubStatusLoading } = useQuery<{
    configured: boolean;
    connected: boolean;
    message: string;
    ideaCount?: number;
  }>({
    queryKey: ["/api/settings/automation-hub/status"],
  });

  const saveTokenMutation = useMutation({
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/settings/automation-hub/token", { token });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/automation-hub/status"] });
      setHubToken("");
      if (data.status?.connected) {
        toast({ title: "Automation Hub connected", description: data.status.message });
      } else {
        toast({ title: "Token saved", description: data.status?.message || "Token saved but connection test failed", variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save token", description: error.message, variant: "destructive" });
    },
  });

  const clearTokenMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/settings/automation-hub/token");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/automation-hub/status"] });
      toast({ title: "Automation Hub token removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove token", description: error.message, variant: "destructive" });
    },
  });

  const { data: hubIdeas, isLoading: hubIdeasLoading } = useQuery<{
    success: boolean;
    ideas?: Array<{
      id: number;
      name: string;
      description: string;
      category: string;
      submittedBy: string;
      status: string;
      department: string;
      createdDate: string;
    }>;
    totalCount?: number;
    message?: string;
  }>({
    queryKey: ["/api/automation-hub/ideas"],
    enabled: !!hubStatus?.connected,
  });

  return (
    <Card className="p-4 sm:p-6 space-y-4" data-testid="card-automation-hub">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-[#e8450a]" />
          <h3 className="text-sm font-semibold text-foreground">Automation Hub</h3>
        </div>
        {hubStatusLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : hubStatus?.connected ? (
          <Badge variant="outline" className="border-green-600 text-green-500 text-[10px]" data-testid="badge-hub-connected">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : hubStatus?.configured ? (
          <Badge variant="outline" className="border-yellow-600 text-yellow-500 text-[10px]" data-testid="badge-hub-error">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Connection Error
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground text-[10px]" data-testid="badge-hub-not-configured">
            Not Configured
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Connect to UiPath Automation Hub to import automation ideas and publish completed automations to the Automation Store.
      </p>

      {hubStatus?.message && !hubStatus.connected && hubStatus.configured && (
        <div className="text-xs text-yellow-500 bg-yellow-500/10 rounded p-2" data-testid="text-hub-error">
          {hubStatus.message}
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Automation Hub Open API Token</Label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={showHubToken ? "text" : "password"}
              placeholder={hubStatus?.configured ? "••••••••" : "Paste your Automation Hub API token"}
              value={hubToken}
              onChange={(e) => setHubToken(e.target.value)}
              className="pr-10 text-sm"
              data-testid="input-hub-token"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowHubToken(!showHubToken)}
              data-testid="button-toggle-hub-token"
            >
              {showHubToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            size="sm"
            onClick={() => saveTokenMutation.mutate(hubToken)}
            disabled={!hubToken.trim() || saveTokenMutation.isPending}
            data-testid="button-save-hub-token"
          >
            {saveTokenMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          {hubStatus?.configured && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => clearTokenMutation.mutate()}
              disabled={clearTokenMutation.isPending}
              data-testid="button-clear-hub-token"
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          Generate an Open API token from Automation Hub &gt; Admin &gt; Open API.
        </p>
      </div>

      {hubStatus?.connected && (
        <div className="space-y-3 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-foreground">Pipeline Ideas</h4>
            {hubStatus.ideaCount !== undefined && (
              <span className="text-[10px] text-muted-foreground" data-testid="text-hub-idea-count">
                {hubStatus.ideaCount} total
              </span>
            )}
          </div>

          {hubIdeasLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : hubIdeas?.success && hubIdeas.ideas && hubIdeas.ideas.length > 0 ? (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto" data-testid="hub-ideas-list">
              {hubIdeas.ideas.slice(0, 10).map((idea) => (
                <div
                  key={idea.id}
                  className="flex items-center justify-between p-2 rounded border border-border hover:bg-muted/30 transition-colors"
                  data-testid={`hub-idea-${idea.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{idea.name}</p>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      {idea.category && <span>{idea.category}</span>}
                      {idea.department && <span>{idea.department}</span>}
                      {idea.status && <Badge variant="outline" className="text-[9px] px-1 py-0">{idea.status}</Badge>}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] text-[#e8450a] hover:text-[#e8450a] hover:bg-[#e8450a]/10 ml-2 shrink-0 px-2"
                    onClick={async () => {
                      try {
                        const res = await apiRequest("POST", `/api/automation-hub/import/${idea.id}`);
                        const data = await res.json();
                        if (data.success) {
                          toast({ title: "Idea imported", description: `"${idea.name}" imported as a new project` });
                          queryClient.invalidateQueries({ queryKey: ["/api/ideas"] });
                        } else {
                          toast({ title: "Import failed", description: data.message, variant: "destructive" });
                        }
                      } catch (err: any) {
                        toast({ title: "Import failed", description: err.message, variant: "destructive" });
                      }
                    }}
                    data-testid={`button-import-hub-idea-${idea.id}`}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    Import
                  </Button>
                </div>
              ))}
            </div>
          ) : hubIdeas?.success && (!hubIdeas.ideas || hubIdeas.ideas.length === 0) ? (
            <p className="text-xs text-muted-foreground text-center py-3">
              No ideas found in Automation Hub.
            </p>
          ) : hubIdeas?.message ? (
            <p className="text-xs text-destructive text-center py-3" data-testid="text-hub-ideas-error">
              {hubIdeas.message}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function CommunicationsMiningPanel() {
  const { toast } = useToast();
  const [cmToken, setCmToken] = useState("");
  const [showCmToken, setShowCmToken] = useState(false);

  const { data: cmStatus, isLoading: cmStatusLoading } = useQuery<{
    configured: boolean;
    connected: boolean;
    message: string;
  }>({
    queryKey: ["/api/settings/communications-mining/status"],
  });

  const saveTokenMutation = useMutation({
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/settings/communications-mining/token", { token });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/communications-mining/status"] });
      setCmToken("");
      if (data.status?.connected) {
        toast({ title: "Communications Mining connected", description: data.status.message });
      } else {
        toast({ title: "Token saved", description: data.status?.message || "Token saved but connection test failed", variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save token", description: error.message, variant: "destructive" });
    },
  });

  const clearTokenMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/settings/communications-mining/token");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/communications-mining/status"] });
      toast({ title: "Communications Mining token removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove token", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card className="p-4 sm:p-6 space-y-4" data-testid="card-communications-mining">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-[#e8450a]" />
          <h3 className="text-sm font-semibold text-foreground">Communications Mining</h3>
        </div>
        {cmStatusLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : cmStatus?.connected ? (
          <Badge variant="outline" className="border-green-600 text-green-500 text-[10px]" data-testid="badge-cm-connected">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : cmStatus?.configured ? (
          <Badge variant="outline" className="border-yellow-600 text-yellow-500 text-[10px]" data-testid="badge-cm-error">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Connection Error
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground text-[10px]" data-testid="badge-cm-not-configured">
            Not Configured
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Connect to UiPath Communications Mining for email/message stream analysis, intent detection, and intelligent routing. This service requires a dedicated API token (not OAuth).
      </p>

      {cmStatus?.message && !cmStatus.connected && cmStatus.configured && (
        <div className="text-xs text-yellow-500 bg-yellow-500/10 rounded p-2" data-testid="text-cm-error">
          {cmStatus.message}
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Communications Mining API Token</Label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={showCmToken ? "text" : "password"}
              placeholder={cmStatus?.configured ? "••••••••" : "Paste your Communications Mining API token"}
              value={cmToken}
              onChange={(e) => setCmToken(e.target.value)}
              className="pr-10 text-sm"
              data-testid="input-cm-token"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowCmToken(!showCmToken)}
              data-testid="button-toggle-cm-token"
            >
              {showCmToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            size="sm"
            onClick={() => saveTokenMutation.mutate(cmToken)}
            disabled={!cmToken.trim() || saveTokenMutation.isPending}
            data-testid="button-save-cm-token"
          >
            {saveTokenMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          {cmStatus?.configured && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => clearTokenMutation.mutate()}
              disabled={clearTokenMutation.isPending}
              data-testid="button-clear-cm-token"
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          Generate this in UiPath IXP &gt; My Account &gt; API token.
        </p>
      </div>
    </Card>
  );
}

function IntegrationsTab() {
  const { toast } = useToast();
  const scopeCategories = useScopeCategories();
  const [step, setStep] = useState(0);
  const [showSecret, setShowSecret] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [editingConnectionId, setEditingConnectionId] = useState<number | null>(null);
  const [showWizard, setShowWizard] = useState(true);
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set(["OR.Default"]));
  const [testResultMsg, setTestResultMsg] = useState<{ success: boolean; message: string } | null>(null);
  const [scopeVerification, setScopeVerification] = useState<{
    success: boolean;
    internalError?: boolean;
    requestedScopes: string[];
    grantedScopes: string[];
    message: string;
    services?: Record<string, { available: boolean; message: string }>;
  } | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedFolderName, setSelectedFolderName] = useState<string | null>(null);
  const [scopeProbe, setScopeProbe] = useState<{
    status: "ok" | "mismatch" | "auth_failed" | "not_configured";
    requestedScopes: string[];
    grantedScopes: string[];
    missingInApp: string[];
    extraInApp: string[];
    message: string;
  } | null>(null);
  const [scopeProbeLoading, setScopeProbeLoading] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: config, isLoading } = useQuery<{
    configured: boolean;
    orgName?: string;
    tenantName?: string;
    clientId?: string;
    scopes?: string;
    hasSecret?: boolean;
    lastTestedAt?: string | null;
    folderId?: string | null;
    folderName?: string | null;
  }>({
    queryKey: ["/api/settings/uipath"],
  });

  const { data: foldersData, isLoading: foldersLoading, refetch: refetchFolders } = useQuery<{
    success: boolean;
    folders?: { id: number; displayName: string; fullyQualifiedName: string }[];
    message?: string;
  }>({
    queryKey: ["/api/settings/uipath/folders"],
    enabled: !!config?.configured,
  });

  const folderMutation = useMutation({
    mutationFn: async (data: { folderId: string | null; folderName: string | null }) => {
      const res = await apiRequest("POST", "/api/settings/uipath/folder", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath"] });
      toast({ title: "Target folder updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save folder", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (config?.configured && !editingConnectionId) {
      setOrgName(config.orgName || "");
      setTenantName(config.tenantName || "");
      setClientId(config.clientId || "");
      const scopeSet = new Set((config.scopes || "OR.Default").split(" ").filter(Boolean));
      setSelectedScopes(scopeSet);
      setSelectedFolderId(config.folderId || null);
      setSelectedFolderName(config.folderName || null);
      setStep(3);
      setShowWizard(false);
    }
  }, [config]);

  const [autoDetectResult, setAutoDetectResult] = useState<{
    status: "synced" | "auth_failed" | "not_configured" | "no_scopes_found";
    detectedScopes: string[];
    previousScopes: string[];
    message: string;
  } | null>(null);
  const [autoDetecting, setAutoDetecting] = useState(false);

  useEffect(() => {
    if (step === 3 && config?.configured && !scopeProbe && !scopeProbeLoading && !autoDetecting && !autoDetectResult) {
      setAutoDetecting(true);
      fetch("/api/settings/uipath/auto-detect-scopes", { method: "POST", credentials: "include" })
        .then(r => r.json())
        .then((data: any) => {
          setAutoDetectResult(data);
          if (data.status === "synced" && data.detectedScopes.length > 0) {
            setSelectedScopes(new Set(data.detectedScopes));
          }
          setScopeProbeLoading(true);
          return fetch("/api/settings/uipath/probe-scopes", { credentials: "include" });
        })
        .then(r => r?.json())
        .then(data => { if (data) setScopeProbe(data); })
        .catch(() => {})
        .finally(() => { setAutoDetecting(false); setScopeProbeLoading(false); });
    }
  }, [step, config?.configured]);

  const toggleScope = (scopeId: string) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scopeId)) {
        if (scopeId === "OR.Default" && next.size === 1) return next;
        next.delete(scopeId);
      } else {
        next.add(scopeId);
      }
      return next;
    });
  };

  const validateStep = (s: number): boolean => {
    const newErrors: Record<string, string> = {};
    if (s === 0) {
      const org = extractOrgSlug(orgName);
      if (!org) newErrors.orgName = "Organization name is required";
      if (!tenantName.trim()) newErrors.tenantName = "Tenant name is required";
    }
    if (s === 1) {
      if (!clientId.trim()) newErrors.clientId = "App ID is required";
      else {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(clientId.trim())) {
          newErrors.clientId = "App ID should be a UUID (e.g. 04c8163f-77fc-4547-86e3-dba0844844fe)";
        }
      }
      if (!clientSecret.trim() && !config?.hasSecret) newErrors.clientSecret = "App Secret is required";
    }
    if (s === 2) {
      if (selectedScopes.size === 0) newErrors.scopes = "Select at least one scope";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const goNext = () => {
    if (validateStep(step)) {
      setErrors({});
      setStep((s) => Math.min(s + 1, 3));
    }
  };

  const goBack = () => {
    setErrors({});
    setStep((s) => Math.max(s - 1, 0));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const scopeStr = Array.from(selectedScopes).join(" ");
      const connPayload = {
        name: connectionName.trim() || `${extractOrgSlug(orgName)} / ${tenantName.trim()}`,
        orgName: extractOrgSlug(orgName),
        tenantName: tenantName.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        scopes: scopeStr,
      };

      if (editingConnectionId) {
        const res = await apiRequest("PATCH", `/api/settings/uipath/connections/${editingConnectionId}`, connPayload);
        return res.json();
      }

      const res = await apiRequest("POST", "/api/settings/uipath/connections", connPayload);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath/connections"] });
      setClientSecret("");
      setScopeProbe(null);
      setAutoDetectResult(null);
      setEditingConnectionId(null);
      if (data.testResult) {
        setTestResultMsg(data.testResult);
        if (data.testResult.success) {
          toast({ title: "Saved & connected", description: "Configuration saved and connection verified." });
        } else {
          toast({ title: "Saved but connection failed", description: data.testResult.message, variant: "destructive" });
        }
      } else {
        toast({ title: "Connection saved" });
      }
      setStep(3);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings/uipath/test");
      return res.json();
    },
    onSuccess: (data: { success: boolean; message: string }) => {
      setTestResultMsg(data);
      queryClient.invalidateQueries({ queryKey: ["/api/settings/uipath"] });
      if (data.success) {
        toast({ title: "Connection successful", description: data.message });
      } else {
        toast({ title: "Connection failed", description: data.message, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Test failed", description: error.message, variant: "destructive" });
    },
  });

  const verifyScopesMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/uipath/verify-scopes", { credentials: "include" });
      return res.json();
    },
    onSuccess: (data: any) => {
      setScopeVerification(data);
      if (data.success) {
        toast({ title: "Scope verification complete", description: data.message });
      } else {
        toast({ title: "Scope verification failed", description: data.message, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Verification failed", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const stepLabels = ["Organization", "Credentials", "Scopes", "Confirm"];

  const handleEditConnection = (conn: UipathConnection) => {
    setEditingConnectionId(conn.id);
    setConnectionName(conn.name);
    setOrgName(conn.orgName);
    setTenantName(conn.tenantName);
    setClientId(conn.clientId);
    setClientSecret("");
    setSelectedScopes(new Set((conn.scopes || "OR.Default").split(" ").filter(Boolean)));
    setSelectedFolderId(conn.folderId || null);
    setSelectedFolderName(conn.folderName || null);
    setTestResultMsg(null);
    setScopeProbe(null);
    setAutoDetectResult(null);
    setErrors({});
    setShowWizard(true);
    setStep(0);
  };

  const handleAddNew = () => {
    setEditingConnectionId(null);
    setConnectionName("");
    setOrgName("");
    setTenantName("");
    setClientId("");
    setClientSecret("");
    setSelectedScopes(new Set(["OR.Default"]));
    setSelectedFolderId(null);
    setSelectedFolderName(null);
    setTestResultMsg(null);
    setScopeProbe(null);
    setAutoDetectResult(null);
    setErrors({});
    setShowWizard(true);
    setStep(0);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <Card className="p-4 sm:p-6 space-y-4" data-testid="card-connections-manager">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-[#e8450a]" />
            <h3 className="text-base sm:text-lg font-semibold text-foreground">Orchestrator Connections</h3>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAddNew}
            data-testid="button-add-connection"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Connection
          </Button>
        </div>
        <ConnectionManagerPanel onEditConnection={handleEditConnection} />
      </Card>

      {showWizard && (
      <Card className="p-4 sm:p-6 space-y-4 sm:space-y-6" data-testid="card-uipath-config">
        <div className="flex flex-col sm:flex-row items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Plug className="h-5 w-5 text-[#e8450a]" />
              <h3 className="text-base sm:text-lg font-semibold text-foreground">
                {editingConnectionId ? "Edit Connection" : "New Connection"}
              </h3>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground">
              {editingConnectionId
                ? "Update this orchestrator connection's settings."
                : "Connect to UiPath Cloud to push automation packages directly."}{" "}
              <a
                href="https://cloud.uipath.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#e8450a] hover:underline"
                data-testid="link-uipath-cloud"
              >
                Open UiPath Cloud
              </a>
            </p>
          </div>
          {config?.configured && !editingConnectionId ? (
            <Badge variant="outline" className="border-green-600 text-green-500 gap-1" data-testid="badge-connected">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </Badge>
          ) : editingConnectionId ? (
            <Button variant="ghost" size="sm" onClick={() => { setShowWizard(false); setEditingConnectionId(null); }} data-testid="button-cancel-edit">
              Cancel
            </Button>
          ) : (
            <Badge variant="outline" className="border-muted-foreground text-muted-foreground gap-1" data-testid="badge-not-configured">
              <XCircle className="h-3 w-3" />
              Not configured
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1" data-testid="wizard-steps">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-1 flex-1">
              <button
                onClick={() => {
                  if (i <= step || config?.configured) {
                    setErrors({});
                    setStep(i);
                  }
                }}
                className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded transition-colors ${
                  i === step
                    ? "bg-[#e8450a] text-white"
                    : i < step
                      ? "bg-[#e8450a]/20 text-[#e8450a] hover:bg-[#e8450a]/30 cursor-pointer"
                      : "bg-muted text-muted-foreground"
                }`}
                data-testid={`wizard-step-${i}`}
              >
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold border border-current">
                  {i < step ? "✓" : i + 1}
                </span>
                {label}
              </button>
              {i < stepLabels.length - 1 && (
                <div className={`flex-1 h-px ${i < step ? "bg-[#e8450a]/40" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-4" data-testid="wizard-panel-org">
            <div className="p-3 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">Step 1: Organization & Tenant</p>
              <p>Find these in your UiPath Cloud URL: <code className="bg-muted px-1 py-0.5 rounded text-[10px]">cloud.uipath.com/<strong>orgName</strong>/<strong>tenantName</strong></code></p>
              <p>You can paste the full URL — the organization name will be extracted automatically.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="connectionName">Connection Name</Label>
              <Input
                id="connectionName"
                placeholder="e.g. Production, Staging, Dev"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                data-testid="input-connection-name"
              />
              <p className="text-xs text-muted-foreground">A friendly name to identify this connection. Auto-generated if left blank.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="orgName">Organization Name <span className="text-destructive">*</span></Label>
              <Input
                id="orgName"
                placeholder="e.g. mycompany or https://cloud.uipath.com/mycompany/"
                value={orgName}
                onChange={(e) => { setOrgName(e.target.value); setErrors((p) => ({ ...p, orgName: "" })); }}
                className={errors.orgName ? "border-destructive" : ""}
                data-testid="input-uipath-org"
              />
              {errors.orgName && <p className="text-xs text-destructive" data-testid="error-org">{errors.orgName}</p>}
              {orgName && orgName.includes("cloud.uipath.com") && (
                <p className="text-xs text-green-500">
                  Will use: <strong>{extractOrgSlug(orgName)}</strong>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tenantName">Tenant Name <span className="text-destructive">*</span></Label>
              <Input
                id="tenantName"
                placeholder="e.g. DefaultTenant"
                value={tenantName}
                onChange={(e) => { setTenantName(e.target.value); setErrors((p) => ({ ...p, tenantName: "" })); }}
                className={errors.tenantName ? "border-destructive" : ""}
                data-testid="input-uipath-tenant"
              />
              {errors.tenantName && <p className="text-xs text-destructive" data-testid="error-tenant">{errors.tenantName}</p>}
              <p className="text-xs text-muted-foreground">Usually "DefaultTenant" unless you renamed it.</p>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4" data-testid="wizard-panel-creds">
            <div className="p-3 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">Step 2: App Credentials</p>
              <p>Create a <strong>Confidential</strong> External Application in UiPath Cloud:</p>
              <p>Admin → External Applications → Add Application → Type: Confidential</p>
              <a
                href="https://cloud.uipath.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#e8450a] hover:underline inline-flex items-center gap-1"
              >
                Open UiPath Cloud Admin
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <div className="space-y-2">
              <Label htmlFor="clientId">App ID (Client ID) <span className="text-destructive">*</span></Label>
              <Input
                id="clientId"
                placeholder="e.g. 04c8163f-77fc-4547-86e3-dba0844844fe"
                value={clientId}
                onChange={(e) => { setClientId(e.target.value); setErrors((p) => ({ ...p, clientId: "" })); }}
                className={errors.clientId ? "border-destructive" : ""}
                data-testid="input-uipath-client-id"
              />
              {errors.clientId && <p className="text-xs text-destructive" data-testid="error-client-id">{errors.clientId}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="clientSecret">App Secret (Client Secret) <span className="text-destructive">*</span></Label>
              <div className="relative">
                <Input
                  id="clientSecret"
                  type={showSecret ? "text" : "password"}
                  placeholder={config?.hasSecret ? "••••••• (saved — leave blank to keep)" : "Paste your app secret"}
                  value={clientSecret}
                  onChange={(e) => { setClientSecret(e.target.value); setErrors((p) => ({ ...p, clientSecret: "" })); }}
                  className={`pr-10 ${errors.clientSecret ? "border-destructive" : ""}`}
                  data-testid="input-uipath-client-secret"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  data-testid="button-toggle-secret"
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.clientSecret && <p className="text-xs text-destructive" data-testid="error-client-secret">{errors.clientSecret}</p>}
              <p className="text-xs text-muted-foreground">
                The secret is shown only once when you create the app. Copy it before closing the dialog.
              </p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4" data-testid="wizard-panel-scopes">
            <div className="p-3 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">Step 3: Scopes (Optional)</p>
              <p>Scopes are <strong className="text-foreground">auto-detected</strong> at Step 4 using your UiPath credentials. You can skip this step.</p>
              <p className="text-muted-foreground">If auto-detection fails, you can manually select scopes here or paste them from UiPath below.</p>
            </div>
            {errors.scopes && <p className="text-xs text-destructive" data-testid="error-scopes">{errors.scopes}</p>}

            <div className="space-y-2">
              <Label htmlFor="paste-scopes" className="text-xs">Paste scopes from UiPath (space or newline separated)</Label>
              <div className="flex gap-2">
                <Input
                  id="paste-scopes"
                  placeholder="e.g. OR.Default OR.Folders.Read OR.Execution.Write ..."
                  data-testid="input-paste-scopes"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val) {
                        const parsed = val.split(/[\s,]+/).filter(s => s.includes("."));
                        if (parsed.length > 0) {
                          const scopeSet = new Set(parsed);
                          scopeSet.add("OR.Default");
                          setSelectedScopes(scopeSet);
                          (e.target as HTMLInputElement).value = "";
                          toast({ title: `${scopeSet.size} scopes loaded`, description: parsed.slice(0, 5).join(", ") + (parsed.length > 5 ? ` + ${parsed.length - 5} more` : "") });
                        }
                      }
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-apply-pasted-scopes"
                  onClick={() => {
                    const input = document.getElementById("paste-scopes") as HTMLInputElement;
                    const val = input?.value?.trim();
                    if (val) {
                      const parsed = val.split(/[\s,]+/).filter(s => s.includes("."));
                      if (parsed.length > 0) {
                        const scopeSet = new Set(parsed);
                        scopeSet.add("OR.Default");
                        setSelectedScopes(scopeSet);
                        input.value = "";
                        toast({ title: `${scopeSet.size} scopes loaded`, description: parsed.slice(0, 5).join(", ") + (parsed.length > 5 ? ` + ${parsed.length - 5} more` : "") });
                      }
                    }
                  }}
                >
                  Apply
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="button-select-all-scopes"
                onClick={() => {
                  const allIds = scopeCategories.flatMap(c => c.scopes.map(s => s.id));
                  setSelectedScopes(new Set(allIds));
                }}
              >
                Select All
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="button-clear-scopes"
                onClick={() => setSelectedScopes(new Set(["OR.Default"]))}
              >
                Clear
              </Button>
              <span className="text-xs text-muted-foreground ml-auto">{selectedScopes.size} selected</span>
            </div>

            <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1" data-testid="scope-list">
              {scopeCategories.map((cat) => {
                const catScopeIds = cat.scopes.map(s => s.id);
                const allChecked = catScopeIds.every(id => selectedScopes.has(id));
                const someChecked = catScopeIds.some(id => selectedScopes.has(id));
                return (
                  <div key={cat.category} className="border border-border rounded-md" data-testid={`scope-category-${cat.category.toLowerCase().replace(/\s+/g, "-")}`}>
                    <label className="flex items-center gap-2 px-3 py-2 bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors rounded-t-md">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                        onChange={() => {
                          setSelectedScopes(prev => {
                            const next = new Set(prev);
                            if (allChecked) {
                              catScopeIds.forEach(id => { if (id !== "OR.Default") next.delete(id); });
                            } else {
                              catScopeIds.forEach(id => next.add(id));
                            }
                            return next;
                          });
                        }}
                        className="accent-[#e8450a] h-3.5 w-3.5"
                        data-testid={`scope-category-toggle-${cat.category.toLowerCase().replace(/\s+/g, "-")}`}
                      />
                      <span className="text-xs font-semibold text-foreground">{cat.category}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">{catScopeIds.filter(id => selectedScopes.has(id)).length}/{catScopeIds.length}</span>
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 px-2 py-1.5">
                      {cat.scopes.map(scope => {
                        const checked = selectedScopes.has(scope.id);
                        return (
                          <label
                            key={scope.id}
                            className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors text-xs ${
                              checked ? "bg-[#e8450a]/5 text-foreground" : "text-muted-foreground hover:text-foreground"
                            }`}
                            data-testid={`scope-item-${scope.id}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleScope(scope.id)}
                              className="accent-[#e8450a] h-3 w-3"
                              data-testid={`scope-checkbox-${scope.id}`}
                            />
                            <code className="text-[10px] font-mono">{scope.id}</code>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Selected ({selectedScopes.size}): <strong className="break-all">{Array.from(selectedScopes).join(", ")}</strong>
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4" data-testid="wizard-panel-confirm">
            <div className="p-3 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground text-sm">Step 4: Review & Connect</p>
              <p>Review your settings below, then save and test the connection.</p>
            </div>

            <div className="space-y-3">
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">Organization</span>
                    <span className="font-medium text-foreground" data-testid="confirm-org">{extractOrgSlug(orgName) || "—"}</span>
                  </div>
                  <button onClick={() => { setErrors({}); setStep(0); }} className="text-[#e8450a] hover:text-[#e8450a]/80 p-1 rounded transition-colors" data-testid="edit-org" title="Edit organization"><Pencil className="h-3 w-3" /></button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">Tenant</span>
                    <span className="font-medium text-foreground" data-testid="confirm-tenant">{tenantName || "—"}</span>
                  </div>
                  <button onClick={() => { setErrors({}); setStep(0); }} className="text-[#e8450a] hover:text-[#e8450a]/80 p-1 rounded transition-colors" data-testid="edit-tenant" title="Edit tenant"><Pencil className="h-3 w-3" /></button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">App ID</span>
                    <span className="font-mono text-xs text-foreground truncate" data-testid="confirm-client-id">{clientId || "—"}</span>
                  </div>
                  <button onClick={() => { setErrors({}); setStep(1); }} className="text-[#e8450a] hover:text-[#e8450a]/80 p-1 rounded transition-colors" data-testid="edit-credentials" title="Edit credentials"><Pencil className="h-3 w-3" /></button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-muted-foreground shrink-0">App Secret</span>
                    <span className="text-foreground" data-testid="confirm-secret">
                      {config?.hasSecret || clientSecret ? "••••••• (set)" : "Not set"}
                    </span>
                  </div>
                  <button onClick={() => { setErrors({}); setStep(1); }} className="text-[#e8450a] hover:text-[#e8450a]/80 p-1 rounded transition-colors" data-testid="edit-secret" title="Edit credentials"><Pencil className="h-3 w-3" /></button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0 flex-1">
                    <span className="text-muted-foreground shrink-0">Scopes</span>
                    <span className="text-foreground text-xs break-all" data-testid="confirm-scopes">
                      {Array.from(selectedScopes).join(", ") || "None"}
                    </span>
                  </div>
                  <button onClick={() => { setErrors({}); setStep(2); }} className="text-[#e8450a] hover:text-[#e8450a]/80 p-1 rounded transition-colors" data-testid="edit-scopes" title="Edit scopes"><Pencil className="h-3 w-3" /></button>
                </div>
              </div>

              {(autoDetecting || scopeProbeLoading) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded border border-border bg-muted/30" data-testid="scope-probe-loading">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {autoDetecting ? "Auto-detecting scopes from UiPath Cloud..." : "Verifying scope sync..."}
                </div>
              )}

              {autoDetectResult && autoDetectResult.status === "synced" && (
                <div className="flex items-start gap-2 text-xs text-green-400 p-2 rounded border border-green-600/30 bg-green-500/10" data-testid="scope-autodetect-synced">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Scopes auto-detected and synced</p>
                    <p className="text-green-400/80">{autoDetectResult.detectedScopes.length} scopes loaded from UiPath Cloud automatically.</p>
                  </div>
                </div>
              )}

              {autoDetectResult && autoDetectResult.status === "auth_failed" && !scopeProbe && (
                <div className="p-3 rounded-md border border-destructive/30 bg-destructive/10 text-destructive text-xs space-y-2" data-testid="scope-autodetect-failed">
                  <div className="flex items-start gap-2">
                    <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">Scope auto-detection failed</p>
                      <p>{autoDetectResult.message}</p>
                    </div>
                  </div>
                </div>
              )}

              {scopeProbe && scopeProbe.status === "ok" && (
                <div className="flex items-center gap-2 text-xs text-green-400 p-2 rounded border border-green-600/30 bg-green-500/10" data-testid="scope-probe-ok">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{scopeProbe.message}</span>
                </div>
              )}

              {scopeProbe && scopeProbe.status === "mismatch" && (
                <div className="p-3 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs space-y-2" data-testid="scope-probe-mismatch">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p className="font-medium">Scope mismatch detected</p>
                      <p>{scopeProbe.message}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setErrors({}); setScopeProbe(null); setAutoDetectResult(null); setStep(2); }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#e8450a] text-white text-xs font-medium hover:bg-[#e8450a]/90 transition-colors"
                    data-testid="button-fix-scopes-mismatch"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit Scopes to Fix
                  </button>
                </div>
              )}

              {scopeProbe && scopeProbe.status === "auth_failed" && (
                <div className="p-3 rounded-md border border-destructive/30 bg-destructive/10 text-destructive text-xs space-y-2" data-testid="scope-probe-failed">
                  <div className="flex items-start gap-2">
                    <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">Scope validation failed</p>
                      <p>{scopeProbe.message}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setErrors({}); setScopeProbe(null); setAutoDetectResult(null); setStep(2); }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#e8450a] text-white text-xs font-medium hover:bg-[#e8450a]/90 transition-colors"
                    data-testid="button-fix-scopes-auth-failed"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit Scopes
                  </button>
                </div>
              )}

              {config?.lastTestedAt && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1" data-testid="last-tested">
                  <Clock className="h-3 w-3" />
                  Last tested: {new Date(config.lastTestedAt).toLocaleString()}
                </div>
              )}

              {testResultMsg && (
                <div
                  className={`p-3 rounded-md border text-sm ${
                    testResultMsg.success
                      ? "border-green-600/30 bg-green-500/10 text-green-400"
                      : "border-destructive/30 bg-destructive/10 text-destructive"
                  }`}
                  data-testid="test-result-msg"
                >
                  <div className="flex items-start gap-2">
                    {testResultMsg.success ? <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />}
                    <span>{testResultMsg.message}</span>
                  </div>
                  {!testResultMsg.success && /invalid_scope/i.test(testResultMsg.message) && (
                    <div className="mt-2 p-2 rounded bg-destructive/5 border border-destructive/20 text-xs space-y-2" data-testid="scope-mismatch-help">
                      <p>Invalid scopes. The scopes you selected must match the scopes granted to your External Application in UiPath Cloud. Go to Admin &gt; External Applications, edit your app, and verify the selected scopes.</p>
                      <button
                        onClick={() => { setErrors({}); setTestResultMsg(null); setStep(2); }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#e8450a] text-white text-xs font-medium hover:bg-[#e8450a]/90 transition-colors"
                        data-testid="button-edit-scopes-from-error"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit Scopes
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                data-testid="button-save-uipath"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving & Testing...
                  </>
                ) : (
                  "Save & Test Connection"
                )}
              </Button>
              {config?.configured && (
                <Button
                  variant="outline"
                  onClick={() => testMutation.mutate()}
                  disabled={testMutation.isPending}
                  data-testid="button-test-uipath"
                >
                  {testMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    "Re-test Connection"
                  )}
                </Button>
              )}
              {config?.configured && (
                <Button
                  variant="outline"
                  onClick={() => verifyScopesMutation.mutate()}
                  disabled={verifyScopesMutation.isPending}
                  data-testid="button-verify-scopes"
                >
                  {verifyScopesMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify Scopes & Services"
                  )}
                </Button>
              )}
            </div>

            {scopeVerification && (
              <div className="border border-border rounded-lg p-4 space-y-3 mt-4" data-testid="scope-verification-results">
                {scopeVerification.internalError ? (
                  <div className="space-y-2" data-testid="internal-error-banner">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-orange-400" />
                      <span className="text-sm font-medium text-orange-400">Internal Error</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      CannonBall encountered an internal error while probing services — this is not a UiPath issue. Please report this to the development team.
                    </p>
                    <p className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1">
                      {scopeVerification.message}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      {scopeVerification.success ? (
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                      <span className="text-sm font-medium text-foreground">{scopeVerification.message}</span>
                    </div>

                    {scopeVerification.services && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Service Availability</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {Object.entries(scopeVerification.services).map(([name, info]) => (
                            <div
                              key={name}
                              className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs ${
                                info.available
                                  ? "bg-green-500/10 text-green-400"
                                  : "bg-amber-500/10 text-amber-400"
                              }`}
                              data-testid={`service-status-${name.toLowerCase().replace(/\s+/g, "-")}`}
                            >
                              {info.available ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <span className="font-medium">{name}</span>
                                <span className="ml-1 text-muted-foreground">— {info.message}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {!scopeVerification.internalError && scopeVerification.grantedScopes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Granted Scopes ({scopeVerification.grantedScopes.length})</p>
                    {(() => {
                      const groups: Record<string, string[]> = {};
                      const labelMap: Record<string, string> = {
                        "OR": "Orchestrator",
                        "TM": "Test Manager",
                        "Du": "Document Understanding",
                        "PM": "Platform Management",
                        "DataFabric": "Data Service",
                        "PIMS": "Maestro",
                        "Ixp": "IXP / Communications Mining",
                        "AI": "AI Center",
                      };
                      for (const scope of scopeVerification.grantedScopes) {
                        const prefix = scope.startsWith("OR.") ? "OR"
                          : scope.startsWith("TM.") ? "TM"
                          : scope.startsWith("Du.") ? "Du"
                          : scope.startsWith("PM.") ? "PM"
                          : scope.startsWith("DataFabric.") ? "DataFabric"
                          : scope.startsWith("PIMS.") ? "PIMS"
                          : scope.startsWith("Ixp.") ? "Ixp"
                          : scope.startsWith("AI.") ? "AI"
                          : "Other";
                        if (!groups[prefix]) groups[prefix] = [];
                        groups[prefix].push(scope);
                      }
                      const colorMap: Record<string, string> = {
                        "OR": "bg-blue-500/10 text-blue-400",
                        "TM": "bg-purple-500/10 text-purple-400",
                        "Du": "bg-amber-500/10 text-amber-400",
                        "PM": "bg-cyan-500/10 text-cyan-400",
                        "DataFabric": "bg-emerald-500/10 text-emerald-400",
                        "PIMS": "bg-rose-500/10 text-rose-400",
                        "Ixp": "bg-teal-500/10 text-teal-400",
                        "AI": "bg-indigo-500/10 text-indigo-400",
                        "Other": "bg-primary/10 text-primary",
                      };
                      return Object.entries(groups).map(([prefix, scopes]) => (
                        <div key={prefix} className="space-y-1">
                          <p className="text-[10px] font-medium text-muted-foreground">
                            {labelMap[prefix] || prefix} ({scopes.length})
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {scopes.map((scope) => (
                              <span key={scope} className={`px-2 py-0.5 rounded-full text-[10px] font-mono ${colorMap[prefix] || colorMap.Other}`}>
                                {scope}
                              </span>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            )}

            {config?.configured && (
              <div className="border-t border-border pt-4 mt-4 space-y-3" data-testid="folder-picker-section">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-[#e8450a]" />
                  <h4 className="text-sm font-semibold text-foreground">Target Folder</h4>
                </div>
                <p className="text-xs text-muted-foreground">
                  Choose which Orchestrator folder packages are uploaded to. If no folder is selected, packages go to the tenant-level feed.
                </p>

                {foldersData && !foldersData.success && (
                  <div className="p-3 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs space-y-1" data-testid="folders-error">
                    <p className="font-medium">Could not load folders</p>
                    <p>{foldersData.message || "Check that your External Application has the OR.Folders scope, then click refresh."}</p>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Select
                    value={selectedFolderId || "__tenant__"}
                    disabled={foldersLoading || (foldersData !== undefined && !foldersData?.success)}
                    onValueChange={(val) => {
                      if (val === "__tenant__") {
                        setSelectedFolderId(null);
                        setSelectedFolderName(null);
                        folderMutation.mutate({ folderId: null, folderName: null });
                      } else {
                        const folder = foldersData?.folders?.find((f) => String(f.id) === val);
                        if (folder) {
                          setSelectedFolderId(String(folder.id));
                          setSelectedFolderName(folder.displayName);
                          folderMutation.mutate({ folderId: String(folder.id), folderName: folder.displayName });
                        }
                      }
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-[280px]" data-testid="select-uipath-folder">
                      <SelectValue placeholder={foldersLoading ? "Loading folders..." : "Select a folder..."} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__tenant__" data-testid="folder-option-tenant">
                        <span className="text-muted-foreground">Tenant feed (no folder)</span>
                      </SelectItem>
                      {foldersData?.folders?.map((folder) => (
                        <SelectItem
                          key={folder.id}
                          value={String(folder.id)}
                          data-testid={`folder-option-${folder.id}`}
                        >
                          {folder.fullyQualifiedName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => refetchFolders()}
                    disabled={foldersLoading}
                    data-testid="button-refresh-folders"
                    title="Refresh folder list"
                  >
                    <RefreshCw className={`h-4 w-4 ${foldersLoading ? "animate-spin" : ""}`} />
                  </Button>
                  {folderMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>

                {selectedFolderName && (
                  <p className="text-xs text-green-500" data-testid="text-selected-folder">
                    Packages will be uploaded to: <strong>{selectedFolderName}</strong>
                  </p>
                )}
                {!selectedFolderId && (
                  <p className="text-xs text-muted-foreground">
                    Packages will appear under Tenant &gt; Packages (tenant-level feed).
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {config?.configured && <OrchestratorHealthPanel />}
        {config?.configured && <IntegrationServicePanel />}

        {config?.configured && <AutomationHubPanel />}
        {config?.configured && <CommunicationsMiningPanel />}

        {step < 3 && (
          <div className="flex items-center gap-3 pt-2">
            {step > 0 && (
              <Button variant="outline" onClick={goBack} data-testid="button-wizard-back">
                Back
              </Button>
            )}
            <Button onClick={goNext} data-testid="button-wizard-next">
              Next
            </Button>
          </div>
        )}
      </Card>
      )}
    </div>
  );
}

function MetadataFreshnessTab() {
  const { toast } = useToast();

  const { data: status, isLoading } = useQuery<{
    generation: {
      loaded: boolean;
      source: string;
      studioTarget: { line: string; version: string; targetFramework: string; expressionLanguage: string } | null;
      packageCount: number;
      lastRefreshedAt: string | null;
      lastVerifiedAt: string | null;
      stalenessLevel: string;
      lastRefreshSuccessAt: string | null;
      lastRefreshFailureAt: string | null;
      packages: Record<string, { preferred: string; min: string; max: string; lastVerifiedAt: string; verificationSource: string }>;
    };
    integration: {
      loaded: boolean;
      endpointCount: number;
      lastRefreshedAt: string | null;
      lastVerifiedAt: string | null;
      stalenessLevel: string;
      lastRefreshSuccessAt: string | null;
      lastRefreshFailureAt: string | null;
      endpoints: Record<string, { confidence: string; reachabilityStatus: string; lastVerifiedAt: string }>;
    };
  }>({ queryKey: ["/api/admin/metadata/status"] });

  const refreshMutation = useMutation({
    mutationFn: async (family?: string) => {
      const res = await apiRequest("POST", "/api/admin/metadata/refresh", family ? { family } : {});
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/metadata/status"] });
      const results = data?.results || {};
      const genSuccess = results.generation?.success !== false;
      const intSuccess = results.integration?.success !== false;
      if (genSuccess && intSuccess) {
        toast({ title: "Metadata refreshed", description: "Snapshots updated successfully." });
      } else {
        const failedFamilies = [
          !genSuccess ? "generation" : null,
          !intSuccess ? "integration" : null,
        ].filter(Boolean).join(", ");
        toast({
          title: "Partial refresh",
          description: `Some families had issues: ${failedFamilies}. Check status for details.`,
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Refresh failed", description: err.message, variant: "destructive" });
    },
  });

  function stalenessColor(level: string) {
    switch (level) {
      case "fresh": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "stale": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "critical": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
    }
  }

  function confidenceBadge(confidence: string) {
    switch (confidence) {
      case "official": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "inferred": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "deprecated": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
    }
  }

  function reachabilityBadge(status: string) {
    switch (status) {
      case "reachable": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "limited": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "unreachable": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
    }
  }

  if (isLoading) {
    return (
      <Card className="p-6" data-testid="card-metadata-loading">
        <div className="space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="panel-metadata-freshness">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold" data-testid="text-metadata-title">Metadata Freshness</h3>
        <Button
          onClick={() => refreshMutation.mutate(undefined)}
          disabled={refreshMutation.isPending}
          size="sm"
          data-testid="button-refresh-metadata"
        >
          {refreshMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh Now
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4" data-testid="card-generation-metadata">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium flex items-center gap-2">
                <Code className="h-4 w-4" />
                Generation Metadata
              </h4>
              {status?.generation.stalenessLevel && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${stalenessColor(status.generation.stalenessLevel)}`} data-testid="badge-generation-staleness">
                  {status.generation.stalenessLevel}
                </span>
              )}
            </div>

            {status?.generation.studioTarget && (
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Studio Target</span>
                  <span className="font-mono" data-testid="text-studio-version">{status.generation.studioTarget.version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Framework</span>
                  <span data-testid="text-target-framework">{status.generation.studioTarget.targetFramework}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Language</span>
                  <span data-testid="text-expression-language">{status.generation.studioTarget.expressionLanguage}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Package Count</span>
                  <span data-testid="text-package-count">{status.generation.packageCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Source</span>
                  <span data-testid="text-generation-source">{status.generation.source}</span>
                </div>
              </div>
            )}

            {status?.generation.lastRefreshedAt && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last refreshed: {new Date(status.generation.lastRefreshedAt).toLocaleString()}
              </div>
            )}

            {(status?.generation.lastRefreshSuccessAt || status?.generation.lastRefreshFailureAt) && (
              <div className="text-xs space-y-0.5" data-testid="gen-refresh-timestamps">
                {status.generation.lastRefreshSuccessAt && (
                  <div className="text-green-600 dark:text-green-400">
                    Last success: {new Date(status.generation.lastRefreshSuccessAt).toLocaleString()}
                  </div>
                )}
                {status.generation.lastRefreshFailureAt && (
                  <div className="text-red-600 dark:text-red-400">
                    Last failure: {new Date(status.generation.lastRefreshFailureAt).toLocaleString()}
                  </div>
                )}
              </div>
            )}

            {status?.generation.packages && Object.keys(status.generation.packages).length > 0 && (
              <div className="space-y-1" data-testid="gen-package-details">
                <p className="text-xs font-medium text-muted-foreground">Packages:</p>
                <div className="space-y-0.5 max-h-32 overflow-y-auto">
                  {Object.entries(status.generation.packages).map(([pkg, info]) => (
                    <div key={pkg} className="text-xs" data-testid={`package-row-${pkg}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-mono truncate mr-2">{pkg.replace("UiPath.", "")}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="font-mono">{info.preferred}</span>
                          <span className="text-muted-foreground">({info.min}–{info.max})</span>
                        </div>
                      </div>
                      <div className="text-muted-foreground text-[10px] flex justify-between">
                        <span>{info.verificationSource}</span>
                        <span data-testid={`verified-at-${pkg}`}>Verified: {new Date(info.lastVerifiedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate("generation")}
              disabled={refreshMutation.isPending}
              data-testid="button-refresh-generation"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Refresh Generation
            </Button>
          </div>
        </Card>

        <Card className="p-4" data-testid="card-integration-metadata">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium flex items-center gap-2">
                <Server className="h-4 w-4" />
                Integration Endpoints
              </h4>
              {status?.integration.stalenessLevel && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${stalenessColor(status.integration.stalenessLevel)}`} data-testid="badge-integration-staleness">
                  {status.integration.stalenessLevel}
                </span>
              )}
            </div>

            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Endpoint Count</span>
                <span data-testid="text-endpoint-count">{status?.integration.endpointCount || 0}</span>
              </div>
            </div>

            {status?.integration.lastRefreshedAt && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last refreshed: {new Date(status.integration.lastRefreshedAt).toLocaleString()}
              </div>
            )}

            {(status?.integration.lastRefreshSuccessAt || status?.integration.lastRefreshFailureAt) && (
              <div className="text-xs space-y-0.5" data-testid="int-refresh-timestamps">
                {status.integration.lastRefreshSuccessAt && (
                  <div className="text-green-600 dark:text-green-400">
                    Last success: {new Date(status.integration.lastRefreshSuccessAt).toLocaleString()}
                  </div>
                )}
                {status.integration.lastRefreshFailureAt && (
                  <div className="text-red-600 dark:text-red-400">
                    Last failure: {new Date(status.integration.lastRefreshFailureAt).toLocaleString()}
                  </div>
                )}
              </div>
            )}

            {status?.integration.endpoints && Object.keys(status.integration.endpoints).length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Endpoints:</p>
                <div className="space-y-1">
                  {Object.entries(status.integration.endpoints).map(([key, ep]) => (
                    <div key={key} className="text-xs" data-testid={`endpoint-row-${key}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-mono">{key}</span>
                        <div className="flex gap-1">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${confidenceBadge(ep.confidence)}`}>
                            {ep.confidence}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-xs ${reachabilityBadge(ep.reachabilityStatus)}`}>
                            {ep.reachabilityStatus}
                          </span>
                        </div>
                      </div>
                      <div className="text-muted-foreground text-[10px] text-right" data-testid={`endpoint-verified-at-${key}`}>
                        Verified: {new Date(ep.lastVerifiedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshMutation.mutate("integration")}
              disabled={refreshMutation.isPending}
              data-testid="button-refresh-integration"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Refresh Integration
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { activeRole } = useAuth();

  if (activeRole !== "Admin") {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-4"
        data-testid="page-access-denied"
      >
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-card border border-border">
          <ShieldAlert className="h-7 w-7 text-destructive" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Access Denied</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            You must be an Admin to access this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6 max-w-6xl mx-auto space-y-4 sm:space-y-6" data-testid="page-settings">
      <div className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold text-foreground">Admin Panel</h1>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Manage users, view audit logs, and monitor system status.
        </p>
      </div>

      <Tabs defaultValue="users" data-testid="tabs-admin">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList data-testid="tablist-admin" className="w-max sm:w-auto">
            <TabsTrigger value="users" data-testid="tab-users">
              <Users className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Users</span>
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              <ScrollText className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Audit Log</span>
            </TabsTrigger>
            <TabsTrigger value="system" data-testid="tab-system">
              <Monitor className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">System</span>
            </TabsTrigger>
            <TabsTrigger value="integrations" data-testid="tab-integrations">
              <Plug className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Integrations</span>
            </TabsTrigger>
            <TabsTrigger value="quality" data-testid="tab-quality">
              <Shield className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Quality</span>
            </TabsTrigger>
            <TabsTrigger value="metadata" data-testid="tab-metadata">
              <Database className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Metadata</span>
            </TabsTrigger>
            <TabsTrigger value="pipeline-health" data-testid="tab-pipeline-health">
              <Activity className="mr-1.5 sm:mr-2 h-4 w-4" />
              <span className="text-xs sm:text-sm">Pipeline Health</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditLogTab />
        </TabsContent>
        <TabsContent value="system" className="mt-4">
          <SystemTab />
        </TabsContent>
        <TabsContent value="integrations" className="mt-4">
          <IntegrationsTab />
        </TabsContent>
        <TabsContent value="quality" className="mt-4">
          <Card data-testid="card-quality-metrics">
            <MetaValidationDashboard />
          </Card>
        </TabsContent>
        <TabsContent value="metadata" className="mt-4">
          <MetadataFreshnessTab />
        </TabsContent>
        <TabsContent value="pipeline-health" className="mt-4">
          <Card data-testid="card-pipeline-health">
            <PipelineHealthDashboard />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
