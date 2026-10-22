/* Generated from schemas/piagent-webui/workspace-paths-v1.schema.json. Do not edit. */

export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};

export interface PiagentWebUIWorkspacePathsV1 {
  schemaVersion: 1;
  version: "piagent-webui-workspace-paths-v1";
  generatedAt: string;
  identity: Identity;
  query: string;
  truncated: boolean;
  /**
   * @maxItems 20
   */
  suggestions:
    | []
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ]
    | [
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        },
        {
          value: string;
          label: string;
          detail: string;
          kind: "file" | "directory";
        }
      ];
}
