import { useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getBezierPath,
  ReactFlowProvider,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { computeProcessAwareLayout, type LayoutInput, type LayoutEdgeInput } from "@shared/process-layout";
import {
  Map,
  X,
  Loader2,
  Play,
  Square,
  Flag,
  User,
  Monitor,
  Bot,
  Zap,
  Brain,
  Repeat,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/components/theme-provider";

interface ProcessNodeData extends Record<string, unknown> {
  label: string;
  role: string;
  system: string;
  nodeType: string;
  isGhost: boolean;
  isPainPoint: boolean;
  description: string;
  viewType: string;
}

interface ProcessEdgeData extends Record<string, unknown> {
  label: string;
  viewType: string;
  totalNodes: number;
  targetIndex?: number;
  targetSiblings?: number;
  targetNodeType?: string;
}

interface DbProcessNode {
  id: number;
  name: string;
  role: string;
  system: string;
  nodeType: string;
  description: string;
  isGhost: boolean;
  isPainPoint: boolean;
  positionX: number;
  positionY: number;
  orderIndex: number;
}

interface DbProcessEdge {
  id: number;
  sourceNodeId: number;
  targetNodeId: number;
  label: string;
}

interface ProcessMapApiResponse {
  nodes: DbProcessNode[];
  edges: DbProcessEdge[];
}

interface RONodeProps {
  data: ProcessNodeData;
  id: string;
}

interface ROEdgeProps {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data?: ProcessEdgeData;
  style?: CSSProperties;
}

function getNodeDimensions(nodeType: string): { width: number; height: number } {
  if (nodeType === "start") return { width: 72, height: 72 };
  if (nodeType === "end") return { width: 72, height: 72 };
  if (nodeType === "decision") return { width: 100, height: 100 };
  if (nodeType === "agent-decision") return { width: 100, height: 120 };
  if (nodeType === "agent-loop") return { width: 280, height: 110 };
  if (nodeType === "agent-task") return { width: 280, height: 120 };
  return { width: 280, height: 100 };
}

function applyDagreLayout(nodes: Node<ProcessNodeData>[], edges: Edge<ProcessEdgeData>[], dbNodes?: DbProcessNode[]): Node<ProcessNodeData>[] {
  const hasOrderIndex = dbNodes && dbNodes.some((n) => n.orderIndex > 0);
  if (hasOrderIndex) {
    const layoutInputs: LayoutInput[] = dbNodes.map((n) => ({
      id: String(n.id),
      nodeType: n.nodeType || "task",
      orderIndex: n.orderIndex,
    }));
    const layoutEdges: LayoutEdgeInput[] = edges.map((e) => {
      const dataLabel = typeof e.data?.label === "string" ? e.data.label : null;
      return { source: e.source, target: e.target, label: dataLabel };
    });
    const positions = computeProcessAwareLayout(layoutInputs, layoutEdges, (nodeType) => getNodeDimensions(nodeType));
    if (positions.size === nodes.length) {
      return nodes.map((node) => {
        const pos = positions.get(node.id);
        return {
          ...node,
          position: pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 },
        };
      });
    }
  }

  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const density = edgeCount / Math.max(nodeCount, 1);
  const isLarge = nodeCount > 30;
  const isVeryLarge = nodeCount > 60;

  let nodesep: number;
  let ranksep: number;
  let edgesep: number;

  if (isVeryLarge) {
    nodesep = Math.round(60 + density * 15);
    ranksep = Math.round(80 + density * 10);
    edgesep = Math.round(25 + density * 8);
  } else if (isLarge) {
    nodesep = Math.round(80 + density * 20);
    ranksep = Math.round(100 + density * 15);
    edgesep = Math.round(30 + density * 10);
  } else {
    nodesep = 100;
    ranksep = 120;
    edgesep = 40;
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep,
    ranksep,
    edgesep,
    marginx: 60,
    marginy: 60,
    ranker: "longest-path",
    align: isLarge ? "UL" : undefined,
  });

  nodes.forEach((node) => {
    const nodeType = node.data.nodeType || "task";
    const dims = getNodeDimensions(nodeType);
    g.setNode(node.id, { width: dims.width, height: dims.height });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  try {
    dagre.layout(g);
  } catch {
    return nodes.map((node, i) => ({
      ...node,
      position: { x: (i % 6) * 200 + 60, y: Math.floor(i / 6) * 150 + 60 },
    }));
  }

  return nodes.map((node) => {
    const pos = g.node(node.id);
    if (!pos) return { ...node, position: { x: 0, y: 0 } };
    const nodeType = node.data.nodeType || "task";
    const dims = getNodeDimensions(nodeType);
    return {
      ...node,
      position: { x: pos.x - dims.width / 2, y: pos.y - dims.height / 2 },
    };
  });
}

type PerformerType = "human" | "system" | "hybrid";

function classifyPerformer(role: string, system: string): PerformerType {
  const r = (role || "").toLowerCase().trim();
  const s = (system || "").toLowerCase().trim();
  const humanKw = ["customer", "user", "officer", "clerk", "analyst", "manager", "agent", "specialist", "admin", "employee", "staff", "reviewer", "approver"];
  const systemKw = ["system", "api", "bot", "erp", "crm", "app", "platform", "email", "portal", "database", "server", "automation", "rpa"];
  const isHuman = humanKw.some((k) => r.includes(k));
  const isSystem = systemKw.some((k) => r.includes(k) || s.includes(k));
  if (isHuman && isSystem) return "hybrid";
  if (isSystem) return "system";
  if (isHuman) return "human";
  if (s && s !== "manual") return "system";
  return "human";
}

const HIDDEN_HANDLE_CLASS = "!w-0 !h-0 !min-w-0 !min-h-0 !border-0 !bg-transparent";

function ROStartNode({ id }: RONodeProps) {
  return (
    <div className="flex items-center justify-center" style={{ width: 72, height: 72 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20"
        style={{ background: "linear-gradient(135deg, #10b981, #059669)", border: "3px solid #34d399" }}
      >
        <Play className="h-5 w-5 text-white ml-0.5" fill="white" />
      </div>
    </div>
  );
}

function ROEndNode({ id }: RONodeProps) {
  return (
    <div className="flex items-center justify-center" style={{ width: 72, height: 72 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Right} id="right-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HIDDEN_HANDLE_CLASS} />
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg shadow-red-500/20"
        style={{ background: "linear-gradient(135deg, #ef4444, #dc2626)", border: "3px solid #f87171" }}
      >
        <Square className="h-4 w-4 text-white" fill="white" />
      </div>
    </div>
  );
}

function RODecisionNode({ data, id }: RONodeProps) {
  const isAutomated = data.viewType === "to-be" && (data.description || "").startsWith("[AUTOMATED]");
  const bgColor = isAutomated ? "#166534" : "#92400e";
  const borderColor = isAutomated ? "#22c55e" : "#f59e0b";
  const glowColor = isAutomated ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.15)";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 100, height: 100 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div
        className="absolute"
        style={{
          width: 70, height: 70, transform: "rotate(45deg)",
          background: `linear-gradient(135deg, ${bgColor}, ${bgColor}dd)`,
          border: `2.5px solid ${borderColor}`, borderRadius: 8,
          boxShadow: `0 4px 20px ${glowColor}`,
        }}
      />
      <div className="relative z-10 text-center" style={{ maxWidth: 80 }}>
        <div className="text-white text-[10px] font-bold leading-tight line-clamp-2 px-0.5">{data.label}</div>
      </div>
      {data.isPainPoint && <Flag className="absolute -top-1.5 -right-1.5 h-3 w-3 text-red-500 fill-red-500 z-20" />}
    </div>
  );
}

function ROAgentDecisionNode({ data, id }: RONodeProps) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 100, height: 100 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div
        className="absolute"
        style={{
          width: 70, height: 70, transform: "rotate(45deg)",
          background: "linear-gradient(135deg, #581c87, #581c87dd)",
          border: "2.5px solid #a855f7", borderRadius: 8,
          boxShadow: "0 4px 20px rgba(168,85,247,0.2)",
        }}
      />
      <div className="relative z-10 text-center" style={{ maxWidth: 80 }}>
        <Brain className="h-3 w-3 text-purple-300 mx-auto mb-0.5" />
        <div className="text-white text-[10px] font-bold leading-tight line-clamp-2 px-0.5">{data.label}</div>
      </div>
      {data.isPainPoint && <Flag className="absolute -top-1.5 -right-1.5 h-3 w-3 text-red-500 fill-red-500 z-20" />}
    </div>
  );
}

function ROTaskNode({ data, id }: RONodeProps) {
  const performer = classifyPerformer(data.role || "", data.system || "");
  const isAutomated = data.viewType === "to-be" && (data.description || "").startsWith("[AUTOMATED]");
  const isGhost = data.isGhost;
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const accentColor = isAutomated ? "#22c55e" : performer === "system" ? "#8b5cf6" : performer === "hybrid" ? "#f59e0b" : "#3b82f6";
  const bgColor = isAutomated
    ? (isDark ? "rgba(22,101,52,0.3)" : "rgba(22,101,52,0.08)")
    : (isDark ? "rgba(30,30,36,0.95)" : "rgba(255,255,255,0.98)");
  const borderColor = isGhost
    ? (isDark ? "rgba(75,75,85,0.5)" : "rgba(209,213,219,0.7)")
    : (isDark ? "rgba(55,55,65,0.8)" : "rgba(229,231,235,1)");
  const PerformerIcon = performer === "system" ? Monitor : performer === "hybrid" ? Bot : User;

  return (
    <div
      className="relative"
      style={{ width: 280, opacity: isGhost ? 0.5 : 1 }}
      data-testid={`ro-node-${id}`}
    >
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: bgColor, border: `1.5px ${isGhost ? "dashed" : "solid"} ${borderColor}`, boxShadow: isDark ? "0 2px 12px rgba(0,0,0,0.3)" : "0 1px 3px rgba(0,0,0,0.08)" }}
      >
        <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88)` }} />
        <div className="px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5" style={{ background: `${accentColor}20`, border: `1px solid ${accentColor}30` }}>
              <PerformerIcon className="h-3.5 w-3.5" style={{ color: accentColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] font-semibold leading-tight line-clamp-2 ${isDark ? "text-white/90" : "text-gray-900"}`}>{data.label}</div>
              {data.role && <div className={`text-[10px] mt-0.5 line-clamp-2 ${isDark ? "text-white/40" : "text-gray-500"}`}>{data.role}</div>}
            </div>
          </div>
          {data.system && data.system !== "manual" && data.system !== "Manual" && (
            <div className="mt-1.5 flex items-center gap-1">
              <Monitor className={`h-3 w-3 ${isDark ? "text-white/25" : "text-gray-400"}`} />
              <span className={`text-[9px] line-clamp-2 ${isDark ? "text-white/30" : "text-gray-400"}`}>{data.system}</span>
            </div>
          )}
          {isAutomated && (
            <div className="mt-1.5 flex items-center gap-1">
              <Zap className="h-2.5 w-2.5 text-green-400" />
              <span className="text-[9px] text-green-400/80 font-medium">Automated</span>
            </div>
          )}
        </div>
      </div>
      {data.isPainPoint && <Flag className="absolute -top-1.5 -right-1.5 h-3 w-3 text-red-500 fill-red-500 z-10" />}
    </div>
  );
}

function ROAgentTaskNode({ data, id }: RONodeProps) {
  const isGhost = data.isGhost;
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const bgColor = isDark ? "rgba(88,28,135,0.25)" : "rgba(147,51,234,0.06)";
  const borderColor = isGhost ? (isDark ? "rgba(139,92,246,0.3)" : "rgba(168,85,247,0.3)") : (isDark ? "rgba(139,92,246,0.5)" : "rgba(168,85,247,0.45)");

  return (
    <div className="relative" style={{ width: 280, opacity: isGhost ? 0.5 : 1 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div className="rounded-xl overflow-hidden" style={{ background: bgColor, border: `1.5px solid ${borderColor}`, boxShadow: isDark ? "0 2px 12px rgba(139,92,246,0.15)" : "0 1px 3px rgba(139,92,246,0.12)" }}>
        <div className="h-1.5 w-full" style={{ background: "linear-gradient(90deg, #a855f7, #c084fc)" }} />
        <div className="px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5" style={{ background: "rgba(168,85,247,0.2)", border: "1px solid rgba(168,85,247,0.3)" }}>
              <Brain className="h-3.5 w-3.5" style={{ color: "#a855f7" }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] font-semibold leading-tight line-clamp-2 ${isDark ? "text-white/90" : "text-gray-900"}`}>{data.label}</div>
              {data.role && <div className={`text-[10px] mt-0.5 line-clamp-2 ${isDark ? "text-white/40" : "text-gray-500"}`}>{data.role}</div>}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <Brain className="h-2.5 w-2.5 text-purple-400" />
            <span className="text-[9px] text-purple-400/80 font-medium">AI Agent</span>
          </div>
        </div>
      </div>
      {data.isPainPoint && <Flag className="absolute -top-1.5 -right-1.5 h-3 w-3 text-red-500 fill-red-500 z-10" />}
    </div>
  );
}

function ROAgentLoopNode({ data, id }: RONodeProps) {
  const isGhost = data.isGhost;
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const bgColor = isDark ? "rgba(88,28,135,0.2)" : "rgba(147,51,234,0.05)";
  const borderColor = isDark ? "rgba(139,92,246,0.4)" : "rgba(168,85,247,0.35)";

  return (
    <div className="relative" style={{ width: 280, opacity: isGhost ? 0.5 : 1 }} data-testid={`ro-node-${id}`}>
      <Handle type="target" position={Position.Top} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="target" position={Position.Left} id="left-target" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Bottom} className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="right" className={HIDDEN_HANDLE_CLASS} />
      <Handle type="source" position={Position.Left} id="left" className={HIDDEN_HANDLE_CLASS} />
      <div className="rounded-xl overflow-hidden" style={{ background: bgColor, border: `2px dashed ${borderColor}`, boxShadow: isDark ? "0 2px 12px rgba(139,92,246,0.12)" : "0 1px 3px rgba(139,92,246,0.1)" }}>
        <div className="h-1.5 w-full" style={{ background: "linear-gradient(90deg, #a855f788, #c084fc88, #a855f788)" }} />
        <div className="px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5" style={{ background: "rgba(168,85,247,0.2)", border: "1px solid rgba(168,85,247,0.3)" }}>
              <Repeat className="h-3.5 w-3.5" style={{ color: "#a855f7" }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[13px] font-semibold leading-tight line-clamp-2 ${isDark ? "text-white/90" : "text-gray-900"}`}>{data.label}</div>
              {data.role && <div className={`text-[10px] mt-0.5 line-clamp-2 ${isDark ? "text-white/40" : "text-gray-500"}`}>{data.role}</div>}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <Repeat className="h-2.5 w-2.5 text-purple-400" />
            <span className="text-[9px] text-purple-400/80 font-medium">Agent Loop</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ROProcessNode({ data, id }: RONodeProps) {
  const nodeType = data.nodeType || "task";
  if (nodeType === "start") return <ROStartNode data={data} id={id} />;
  if (nodeType === "end") return <ROEndNode data={data} id={id} />;
  if (nodeType === "decision") return <RODecisionNode data={data} id={id} />;
  if (nodeType === "agent-task") return <ROAgentTaskNode data={data} id={id} />;
  if (nodeType === "agent-decision") return <ROAgentDecisionNode data={data} id={id} />;
  if (nodeType === "agent-loop") return <ROAgentLoopNode data={data} id={id} />;
  return <ROTaskNode data={data} id={id} />;
}

function ROCustomEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }: ROEdgeProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const totalNodes = data?.totalNodes || 0;
  const useBezier = totalNodes > 25;
  const label = data?.label || "";
  const targetNodeType = data?.targetNodeType || "task";
  const targetIndex = data?.targetIndex || 0;
  const targetSiblings = data?.targetSiblings || 1;
  const isYes = /^(yes|approved|pass|valid|complete|true|within|below|stp|auto)/i.test(label);
  const isNo = /^(no|rejected|fail|invalid|incomplete|false|exceed|above|poor|flag)/i.test(label);
  const isToBeView = data?.viewType === "to-be";

  let edgeColor = isDark ? "rgba(120,120,145,0.35)" : "rgba(100,116,139,0.45)";
  if (isToBeView) edgeColor = isDark ? "rgba(34,197,94,0.5)" : "rgba(34,197,94,0.6)";
  else if (isYes) edgeColor = "rgba(34,197,94,0.7)";
  else if (isNo) edgeColor = "rgba(239,68,68,0.7)";
  else if (label) edgeColor = isDark ? "rgba(148,163,184,0.5)" : "rgba(100,116,139,0.6)";

  const isEndTarget = targetNodeType === "end";
  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (isEndTarget && targetSiblings > 1) {
    const dy = targetY - sourceY;
    const fanSpread = (targetIndex - (targetSiblings - 1) / 2) * Math.min(35, 180 / targetSiblings);
    const cx1 = sourceX;
    const cy1 = sourceY + dy * 0.4;
    const cx2 = targetX + fanSpread;
    const cy2 = targetY - Math.abs(dy) * 0.3;
    edgePath = `M ${sourceX},${sourceY} C ${cx1},${cy1} ${cx2},${cy2} ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2 + fanSpread * 0.3;
    labelY = (sourceY + targetY) / 2;
  } else {
    [edgePath, labelX, labelY] = useBezier
      ? getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
      : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 16, offset: 20 });
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ ...style, stroke: edgeColor, strokeWidth: label ? 1.5 : 1.2, strokeLinecap: "round" }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "none", zIndex: 10 }}
            className={`px-2 py-0.5 rounded text-[9px] font-medium max-w-[140px] truncate ${
              isYes ? (isDark ? "bg-emerald-950/95 border border-emerald-500/30 text-emerald-300" : "bg-emerald-50 border border-emerald-300 text-emerald-700")
              : isNo ? (isDark ? "bg-red-950/95 border border-red-500/30 text-red-300" : "bg-red-50 border border-red-300 text-red-700")
              : (isDark ? "bg-popover/95 border border-border text-muted-foreground" : "bg-popover border border-border text-muted-foreground")
            }`}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const roNodeTypes: NodeTypes = { processNode: ROProcessNode };
const roEdgeTypes: EdgeTypes = { custom: ROCustomEdge };

function ReadOnlyFlowContent({ nodes, edges }: { nodes: Node<ProcessNodeData>[]; edges: Edge<ProcessEdgeData>[]; viewType: string }) {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={roNodeTypes}
      edgeTypes={roEdgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag={true}
      zoomOnScroll={true}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
      minZoom={0.1}
      maxZoom={2}
      defaultEdgeOptions={{ type: "custom", markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 } }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"} />
      <Controls showInteractive={false} className="!bg-card !border-border !shadow-lg" />
      <MiniMap
        nodeColor={(n) => {
          const nt = (n.data as ProcessNodeData)?.nodeType;
          if (nt === "start") return "#10b981";
          if (nt === "end") return "#ef4444";
          if (nt === "decision") return "#f59e0b";
          if (nt === "agent-task" || nt === "agent-decision" || nt === "agent-loop") return "#a855f7";
          return "#3b82f6";
        }}
        maskColor={isDark ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.7)"}
        className="!bg-card/80 !border-border"
        style={{ width: 120, height: 80 }}
      />
    </ReactFlow>
  );
}

interface ProcessMapViewerModalProps {
  open: boolean;
  onClose: () => void;
  ideaId: string;
  viewType: "as-is" | "to-be";
}

export function ProcessMapViewerModal({ open, onClose, ideaId, viewType }: ProcessMapViewerModalProps) {
  const label = viewType === "as-is" ? "As-Is Process Map" : "To-Be Process Map";

  const { data: mapData, isLoading, isError } = useQuery<ProcessMapApiResponse>({
    queryKey: ["/api/ideas", ideaId, "process-map", viewType, "ro-view"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${ideaId}/process-map?view=${viewType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load process map");
      return res.json();
    },
    enabled: open,
  });

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!mapData?.nodes?.length) return { flowNodes: [] as Node<ProcessNodeData>[], flowEdges: [] as Edge<ProcessEdgeData>[] };

    const rawNodes: Node<ProcessNodeData>[] = mapData.nodes.map((n) => ({
      id: String(n.id),
      type: "processNode" as const,
      position: { x: 0, y: 0 },
      data: {
        label: n.name,
        role: n.role,
        system: n.system,
        nodeType: n.nodeType,
        isGhost: n.isGhost,
        isPainPoint: n.isPainPoint,
        description: n.description,
        viewType,
      },
    }));

    const nodeIdSet = new Set(mapData.nodes.map((n) => n.id));
    const nodeTypeMap: Record<string, string> = {};
    mapData.nodes.forEach(n => { nodeTypeMap[String(n.id)] = n.nodeType || "task"; });
    const validEdges = (mapData.edges || []).filter((e) => nodeIdSet.has(e.sourceNodeId) && nodeIdSet.has(e.targetNodeId));
    const totalNodes = rawNodes.length;
    const srcGroups: Record<string, typeof validEdges> = {};
    const tgtGroups: Record<string, typeof validEdges> = {};
    validEdges.forEach(e => {
      const sk = String(e.sourceNodeId);
      const tk = String(e.targetNodeId);
      if (!srcGroups[sk]) srcGroups[sk] = [];
      srcGroups[sk].push(e);
      if (!tgtGroups[tk]) tgtGroups[tk] = [];
      tgtGroups[tk].push(e);
    });

    const getEdgeSourceHandle = (isDecision: boolean, label: string, siblings: typeof validEdges, edge: typeof validEdges[0]): string => {
      if (!isDecision) return "bottom";
      const lbl = (label || "").trim();
      if (/^(no|rejected|fail|invalid|incomplete|false|exceed|above|poor|flag)/i.test(lbl)) return "right";
      if (/^(yes|approved|pass|valid|complete|true|within|below|stp|auto)/i.test(lbl)) return "left";
      if (siblings.length > 1) {
        const idx = siblings.indexOf(edge);
        if (idx === 0) return "left";
        if (idx === 1) return "right";
        return "bottom";
      }
      return "left";
    };

    const rawEdges: Edge<ProcessEdgeData>[] = validEdges.map((e) => {
      const srcS = srcGroups[String(e.sourceNodeId)] || [e];
      const tgtS = tgtGroups[String(e.targetNodeId)] || [e];
      const srcType = nodeTypeMap[String(e.sourceNodeId)] || "task";
      const isDecision = srcType === "decision" || srcType === "agent-decision";
      const sourceHandle = getEdgeSourceHandle(isDecision, e.label, srcS, e);
      return {
        id: String(e.id),
        source: String(e.sourceNodeId),
        target: String(e.targetNodeId),
        type: "custom" as const,
        sourceHandle,
        targetHandle: "top",
        data: {
          label: e.label, viewType, totalNodes,
          targetIndex: tgtS.indexOf(e), targetSiblings: tgtS.length,
          targetNodeType: nodeTypeMap[String(e.targetNodeId)] || "task",
        },
      };
    });

    const layoutNodes = rawEdges.length > 0
      ? applyDagreLayout(rawNodes, rawEdges, mapData.nodes)
      : rawNodes.map((node, i) => ({
          ...node,
          position: { x: 80 + (i % 3) * 260, y: 80 + Math.floor(i / 3) * 120 },
        }));

    const nodePositions: Record<string, { x: number; y: number }> = {};
    layoutNodes.forEach((n) => {
      const dims = getNodeDimensions(n.data.nodeType || "task");
      nodePositions[n.id] = { x: n.position.x + dims.width / 2, y: n.position.y + dims.height / 2 };
    });

    const fixedEdges = rawEdges.map((edge) => {
      const srcType = nodeTypeMap[edge.source] || "task";
      const isDecision = srcType === "decision" || srcType === "agent-decision";
      if (!isDecision) return edge;

      const srcPos = nodePositions[edge.source];
      const tgtPos = nodePositions[edge.target];
      if (!srcPos || !tgtPos) return edge;

      const lbl = (edge.data?.label || "").trim();
      const isNoEdge = /^(no|rejected|fail|invalid|incomplete|false|exceed|above|poor|flag)/i.test(lbl);
      const isYesEdge = /^(yes|approved|pass|valid|complete|true|within|below|stp|auto)/i.test(lbl);

      let sideHandle: string;
      if (isNoEdge) {
        sideHandle = "right";
      } else if (isYesEdge) {
        sideHandle = "left";
      } else {
        sideHandle = tgtPos.x > srcPos.x ? "right" : "left";
      }

      const dyFromSrc = tgtPos.y - srcPos.y;
      const targetHandle = dyFromSrc > Math.abs(tgtPos.x - srcPos.x) * 0.5 ? "top" : (sideHandle === "left" ? "right" : "left");
      return { ...edge, sourceHandle: sideHandle, targetHandle };
    });

    return { flowNodes: layoutNodes, flowEdges: fixedEdges };
  }, [mapData, viewType]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid={`modal-view-${viewType}`} onClick={onClose}>
      <div className="relative w-[92vw] max-w-6xl h-[85vh] bg-card rounded-xl border border-border shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Map className="h-4 w-4 text-cb-teal" />
            <h3 className="text-sm font-semibold text-foreground">{label}</h3>
            {flowNodes.length > 0 && (
              <Badge variant="outline" className="text-[10px]">{flowNodes.length} steps</Badge>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-close-modal-${viewType}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-cb-teal" />
              <span className="ml-2 text-sm text-muted-foreground">Loading process map...</span>
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-full gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              <span className="text-sm text-destructive">Failed to load process map data.</span>
            </div>
          ) : flowNodes.length > 0 ? (
            <ReactFlowProvider>
              <ReadOnlyFlowContent nodes={flowNodes} edges={flowEdges} viewType={viewType} />
            </ReactFlowProvider>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">No process map data available.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
