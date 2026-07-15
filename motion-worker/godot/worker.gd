extends Node2D

var request_path := ""
var result_path := ""

func _ready() -> void:
    _parse_args()
    if request_path.is_empty() or result_path.is_empty():
        push_error("--request and --result are required")
        get_tree().quit(2)
        return
    var request := _read_json(request_path)
    if request == null:
        _write_result({"protocolVersion": 1, "requestId": "unknown", "status": "failed", "warnings": [], "error": {"code": "REQUEST_INVALID", "message": "Cannot parse request JSON"}})
        get_tree().quit(3)
        return
    var rig := _read_json(str(request.get("rigPath", "")))
    if rig == null:
        _write_result({"protocolVersion": 1, "requestId": request.get("requestId", "unknown"), "status": "failed", "warnings": [], "error": {"code": "RIG_INVALID", "message": "Cannot parse rig JSON"}})
        get_tree().quit(4)
        return
    _build_sample_skeleton(rig)
    # Phase 1 proves the local JSON/file call chain. Production-quality mesh
    # weighting and transparent encoders remain explicit future work.
    _write_result({
        "protocolVersion": 1,
        "requestId": request.get("requestId", "unknown"),
        "status": "unsupported",
        "warnings": ["Sample worker loaded the continuous texture rig; production mesh rendering is not enabled in Phase 1."],
        "error": {"code": "MESH_RENDER_PLANNED", "message": "Use Rigid Actor or Pose Cut until the rig is manually verified."}
    })
    get_tree().quit(0)

func _parse_args() -> void:
    var args := OS.get_cmdline_user_args()
    for index in range(args.size()):
        if args[index] == "--request" and index + 1 < args.size():
            request_path = args[index + 1]
        if args[index] == "--result" and index + 1 < args.size():
            result_path = args[index + 1]

func _read_json(file_path: String):
    if file_path.is_empty() or not FileAccess.file_exists(file_path):
        return null
    var file := FileAccess.open(file_path, FileAccess.READ)
    return JSON.parse_string(file.get_as_text())

func _write_result(result: Dictionary) -> void:
    var file := FileAccess.open(result_path, FileAccess.WRITE)
    file.store_string(JSON.stringify(result, "  "))

func _build_sample_skeleton(rig: Dictionary) -> void:
    var skeleton := Skeleton2D.new()
    skeleton.name = "ImportedSkeleton"
    add_child(skeleton)
    var bone_nodes := {}
    for bone_data in rig.get("bones", []):
        var bone := Bone2D.new()
        bone.name = str(bone_data.get("id", "bone"))
        bone.position = Vector2(float(bone_data.get("x", 0)), float(bone_data.get("y", 0)))
        bone.rotation = deg_to_rad(float(bone_data.get("rotation", 0)))
        var parent_id := str(bone_data.get("parentId", ""))
        if not parent_id.is_empty() and bone_nodes.has(parent_id):
            bone_nodes[parent_id].add_child(bone)
        else:
            skeleton.add_child(bone)
        bone_nodes[bone.name] = bone
