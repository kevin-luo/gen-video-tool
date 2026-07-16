extends Node

const PROTOCOL_VERSION := 1
const FRAME_PREFIX := "frame_"

var request_path := ""
var result_path := ""
var request: Dictionary = {}
var rig: Dictionary = {}
var action_template: Dictionary = {}
var viewport: SubViewport
var stage: Node2D
var skeleton: Skeleton2D
var polygon: Polygon2D
var bones: Dictionary = {}
var rest_pose: Dictionary = {}
var warnings: Array[String] = []


func _ready() -> void:
	_run()


func _run() -> void:
	_parse_args()
	if request_path.is_empty() or result_path.is_empty():
		_fail("REQUEST_PATH_REQUIRED", "--request and --result are required", 2)
		return

	var request_value = _read_json(request_path)
	if not request_value is Dictionary:
		_fail("REQUEST_INVALID", "Cannot parse request JSON", 3)
		return
	request = request_value
	var request_error := _validate_request(request)
	if not request_error.is_empty():
		_fail("REQUEST_INVALID", request_error, 3)
		return

	var rig_value = _read_json(str(request.get("rigPath", "")))
	if not rig_value is Dictionary:
		_fail("RIG_INVALID", "Cannot parse rig JSON", 4)
		return
	rig = rig_value
	var rig_error := _validate_rig(rig)
	if not rig_error.is_empty():
		_fail("RIG_INVALID", rig_error, 4)
		return

	var template_value = _load_action_template(str(request.action.template))
	if not template_value is Dictionary:
		_fail("ACTION_TEMPLATE_INVALID", "Cannot load action template: %s" % request.action.template, 5)
		return
	action_template = template_value

	var texture_image := Image.new()
	var texture_error := texture_image.load(str(request.texturePath))
	if texture_error != OK or texture_image.is_empty():
		_fail("TEXTURE_INVALID", "Cannot load complete character PNG", 6)
		return
	if texture_image.detect_alpha() == Image.ALPHA_NONE:
		_fail("TEXTURE_ALPHA_REQUIRED", "Mesh Puppet texture must contain an alpha channel", 6)
		return

	var build_error := _build_puppet(texture_image)
	if not build_error.is_empty():
		_fail("PUPPET_BUILD_FAILED", build_error, 7)
		return

	var render_result := await _render_frames()
	if render_result.has("error"):
		_fail("FRAME_RENDER_FAILED", str(render_result.error), 8)
		return

	var output_path := str(render_result.outputPath)
	if str(request.output.format) != "png-sequence":
		var encode_result := _encode_alpha_video(str(render_result.framesDirectory))
		if encode_result.has("error"):
			_fail("ALPHA_ENCODE_FAILED", str(encode_result.error), 9)
			return
		output_path = str(encode_result.outputPath)
		if bool(request.output.get("cleanupFrames", true)):
			_remove_tree(str(render_result.framesDirectory))

	_write_result({
		"protocolVersion": PROTOCOL_VERSION,
		"requestId": str(request.requestId),
		"status": "complete",
		"outputPath": output_path,
		"frameCount": int(request.action.durationInFrames),
		"fps": int(request.action.fps),
		"width": int(request.output.width),
		"height": int(request.output.height),
		"format": str(request.output.format),
		"hasAlpha": true,
		"warnings": warnings,
	})
	get_tree().quit(0)


func _parse_args() -> void:
	var args := OS.get_cmdline_user_args()
	for index in range(args.size()):
		if args[index] == "--request" and index + 1 < args.size():
			request_path = args[index + 1]
		elif args[index] == "--result" and index + 1 < args.size():
			result_path = args[index + 1]


func _validate_request(value: Dictionary) -> String:
	if int(value.get("protocolVersion", 0)) != PROTOCOL_VERSION:
		return "Unsupported protocolVersion"
	for key in ["requestId", "projectId", "actorId", "texturePath", "rigPath"]:
		if str(value.get(key, "")).is_empty():
			return "%s is required" % key
	if not value.get("action") is Dictionary or not value.get("output") is Dictionary:
		return "action and output must be objects"
	var action: Dictionary = value.action
	var output: Dictionary = value.output
	if int(action.get("durationInFrames", 0)) < 1 or int(action.get("durationInFrames", 0)) > 1800:
		return "durationInFrames must be between 1 and 1800"
	var action_start := int(action.get("startFrame", 0))
	var active_duration := int(action.get("activeDurationInFrames", int(action.durationInFrames) - action_start))
	if action_start < 0 or active_duration < 1 or action_start + active_duration > int(action.durationInFrames):
		return "Mesh action timing must stay inside durationInFrames"
	if int(action.get("fps", 0)) < 1 or int(action.get("fps", 0)) > 120:
		return "fps must be between 1 and 120"
	if float(action.get("amplitude", -1.0)) < 0.0 or float(action.get("amplitude", 2.0)) > 1.0:
		return "amplitude must be between 0 and 1"
	if not str(output.get("format", "")) in ["png-sequence", "transparent-webm", "alpha-mov"]:
		return "Unsupported output format"
	if int(output.get("width", 0)) < 2 or int(output.get("height", 0)) < 2:
		return "output width and height must be at least 2"
	if not str(output.get("format")) == "png-sequence" and str(value.get("ffmpegPath", "")).is_empty():
		return "ffmpegPath is required for transparent video output"
	return ""


func _validate_rig(value: Dictionary) -> String:
	if not int(value.get("schemaVersion", 0)) in [1, 2]:
		return "rig schemaVersion must be 1 or 2"
	if not value.get("canvas") is Dictionary or not value.get("mesh") is Dictionary:
		return "rig canvas and mesh are required"
	if not value.get("bones") is Array or value.bones.is_empty():
		return "rig bones must contain at least one bone"
	var mesh: Dictionary = value.mesh
	if not mesh.get("vertices") is Array or mesh.vertices.size() < 3:
		return "mesh requires at least three vertices"
	if not mesh.get("triangles") is Array or mesh.triangles.is_empty():
		return "mesh requires triangles"
	if not mesh.get("weights") is Array or mesh.weights.size() != mesh.vertices.size():
		return "mesh weights must match vertex count"
	var ids := {}
	for bone_value in value.bones:
		if not bone_value is Dictionary:
			return "each bone must be an object"
		var bone_id := str(bone_value.get("id", ""))
		if bone_id.is_empty() or ids.has(bone_id):
			return "bone ids must be unique and non-empty"
		if not bone_value.get("pivot") is Dictionary or not bone_value.get("tip") is Dictionary:
			return "bone %s requires pivot and tip" % bone_id
		ids[bone_id] = true
	for bone_value in value.bones:
		var parent_id = bone_value.get("parentId")
		if parent_id != null and not ids.has(str(parent_id)):
			return "bone %s references missing parent %s" % [bone_value.id, parent_id]
	for index in range(mesh.weights.size()):
		var influences = mesh.weights[index]
		if not influences is Array or influences.is_empty():
			return "vertex %d has no bone weights" % index
		var total := 0.0
		for influence in influences:
			if not ids.has(str(influence.get("boneId", ""))):
				return "vertex %d references a missing bone" % index
			total += float(influence.get("weight", 0.0))
		if abs(total - 1.0) > 0.001:
			return "vertex %d weights must sum to 1" % index
	return ""


func _load_action_template(template_id: String):
	var library = _read_json(ProjectSettings.globalize_path("res://actions/action-templates.json"))
	if not library is Dictionary or not library.get("templates") is Array:
		return null
	for candidate in library.templates:
		if candidate is Dictionary and str(candidate.get("id", "")) == template_id:
			if int(candidate.get("schemaVersion", 0)) == 1 and candidate.get("tracks") is Dictionary:
				return candidate
	return null


func _build_puppet(texture_image: Image) -> String:
	viewport = SubViewport.new()
	viewport.name = "TransparentViewport"
	viewport.size = Vector2i(int(request.output.width), int(request.output.height))
	viewport.transparent_bg = true
	viewport.render_target_clear_mode = SubViewport.CLEAR_MODE_ALWAYS
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.world_2d = World2D.new()
	add_child(viewport)

	stage = Node2D.new()
	stage.name = "PuppetStage"
	viewport.add_child(stage)

	var canvas: Dictionary = rig.canvas
	var canvas_size := Vector2(float(canvas.width), float(canvas.height))
	var output_size := Vector2(float(request.output.width), float(request.output.height))
	var fit_scale: float = min(output_size.x / canvas_size.x, output_size.y / canvas_size.y)
	stage.scale = Vector2.ONE * fit_scale
	stage.position = (output_size - canvas_size * fit_scale) * 0.5

	skeleton = Skeleton2D.new()
	skeleton.name = "ImportedSkeleton"
	stage.add_child(skeleton)
	var bone_error := _build_bones(rig.bones)
	if not bone_error.is_empty():
		return bone_error

	polygon = Polygon2D.new()
	polygon.name = "ContinuousCharacterMesh"
	polygon.antialiased = true
	polygon.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	polygon.texture = ImageTexture.create_from_image(texture_image)
	stage.add_child(polygon)

	var mesh: Dictionary = rig.mesh
	var points := PackedVector2Array()
	var uvs := PackedVector2Array()
	var texture_scale := Vector2(float(texture_image.get_width()) / canvas_size.x, float(texture_image.get_height()) / canvas_size.y)
	for vertex in mesh.vertices:
		var point := Vector2(float(vertex.x), float(vertex.y))
		points.append(point)
		uvs.append(point * texture_scale)
	polygon.polygon = points
	polygon.uv = uvs
	var polygons_array: Array[PackedInt32Array] = []
	for triangle in mesh.triangles:
		polygons_array.append(PackedInt32Array([int(triangle[0]), int(triangle[1]), int(triangle[2])]))
	polygon.polygons = polygons_array
	var boundary_count := int(mesh.get("boundaryVertexCount", mesh.vertices.size()))
	polygon.internal_vertex_count = max(0, mesh.vertices.size() - boundary_count)
	polygon.skeleton = polygon.get_path_to(skeleton)
	for bone_id in bones.keys():
		var packed_weights := PackedFloat32Array()
		for vertex_weights in mesh.weights:
			var value := 0.0
			for influence in vertex_weights:
				if str(influence.boneId) == str(bone_id):
					value = float(influence.weight)
			packed_weights.append(value)
		var bone: Bone2D = bones[bone_id]
		polygon.add_bone(polygon.get_path_to(bone), packed_weights)
	return ""


func _build_bones(definitions: Array) -> String:
	var pending := definitions.duplicate(true)
	var absolute_angles := {}
	var pivots := {}
	while not pending.is_empty():
		var progressed := false
		for index in range(pending.size() - 1, -1, -1):
			var definition: Dictionary = pending[index]
			var parent_value = definition.get("parentId")
			var parent_id := "" if parent_value == null else str(parent_value)
			if not parent_id.is_empty() and not bones.has(parent_id):
				continue
			var pivot := Vector2(float(definition.pivot.x), float(definition.pivot.y))
			var tip := Vector2(float(definition.tip.x), float(definition.tip.y))
			var absolute_angle := (tip - pivot).angle()
			var bone := Bone2D.new()
			bone.name = str(definition.id)
			bone.set_autocalculate_length_and_angle(false)
			bone.set_length(max(1.0, pivot.distance_to(tip)))
			bone.set_bone_angle(0.0)
			if parent_id.is_empty():
				bone.position = pivot
				bone.rotation = absolute_angle
				skeleton.add_child(bone)
			else:
				var parent_bone: Bone2D = bones[parent_id]
				var parent_angle: float = absolute_angles[parent_id]
				bone.position = (pivot - Vector2(pivots[parent_id])).rotated(-parent_angle)
				bone.rotation = wrapf(absolute_angle - parent_angle, -PI, PI)
				parent_bone.add_child(bone)
			bone.rest = bone.transform
			bones[str(definition.id)] = bone
			absolute_angles[str(definition.id)] = absolute_angle
			pivots[str(definition.id)] = pivot
			rest_pose[str(definition.id)] = {
				"position": bone.position,
				"rotation": bone.rotation,
				"scale": bone.scale,
			}
			pending.remove_at(index)
			progressed = true
		if not progressed:
			return "Bone hierarchy contains a cycle or unresolved parent"
	return ""


func _render_frames() -> Dictionary:
	var output_directory := str(request.output.directory)
	var frames_directory := output_directory
	if str(request.output.format) != "png-sequence":
		frames_directory = output_directory.path_join(".%s-frames" % str(request.requestId))
	var mkdir_error := DirAccess.make_dir_recursive_absolute(frames_directory)
	if mkdir_error != OK:
		return {"error": "Cannot create output directory"}

	var frame_count := int(request.action.durationInFrames)
	var captured_alpha := false
	for frame in range(frame_count):
		_apply_action(frame)
		viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
		await RenderingServer.frame_post_draw
		var image := viewport.get_texture().get_image()
		if image.is_empty():
			return {"error": "Viewport returned an empty frame at %d" % frame}
		image.convert(Image.FORMAT_RGBA8)
		if frame == 0 or frame == frame_count / 2:
			captured_alpha = captured_alpha or image.detect_alpha() != Image.ALPHA_NONE
		var frame_path := frames_directory.path_join("%s%06d.png" % [FRAME_PREFIX, frame])
		var save_error := image.save_png(frame_path)
		if save_error != OK:
			return {"error": "Cannot save frame %d" % frame}
	if not captured_alpha:
		return {"error": "Rendered frames do not contain transparency"}
	return {
		"outputPath": frames_directory,
		"framesDirectory": frames_directory,
	}


func _apply_action(frame: int) -> void:
	for bone_id in bones.keys():
		var bone: Bone2D = bones[bone_id]
		var rest: Dictionary = rest_pose[bone_id]
		bone.position = rest.position
		bone.rotation = float(rest.rotation)
		bone.scale = rest.scale

	var action_start := int(request.action.get("startFrame", 0))
	var active_duration := int(request.action.get("activeDurationInFrames", int(request.action.durationInFrames) - action_start))
	var action_frame: int = clamp(frame - action_start, 0, max(0, active_duration - 1))
	var template_duration := float(action_template.get("duration", 1.0))
	var template_time := 0.0
	if bool(action_template.get("loop", false)) and frame >= action_start:
		template_time = fmod(float(action_frame) / float(request.action.fps), template_duration)
	else:
		var action_divisor: int = max(1, active_duration - 1)
		template_time = float(action_frame) / float(action_divisor) * template_duration
	var amplitude := float(request.action.amplitude)
	var tracks: Dictionary = action_template.tracks
	for bone_id in tracks.keys():
		if not bones.has(str(bone_id)):
			var warning := "Action %s skipped missing bone %s" % [action_template.id, bone_id]
			if not warnings.has(warning):
				warnings.append(warning)
			continue
		var sample := _sample_track(tracks[bone_id], template_time)
		var bone: Bone2D = bones[str(bone_id)]
		var rest: Dictionary = rest_pose[str(bone_id)]
		bone.position = Vector2(rest.position) + Vector2(float(sample.get("x", 0.0)), float(sample.get("y", 0.0))) * amplitude
		bone.rotation = float(rest.rotation) + deg_to_rad(float(sample.get("rotation", 0.0)) * amplitude)
		var scale_x: float = lerp(1.0, float(sample.get("scaleX", 1.0)), amplitude)
		var scale_y: float = lerp(1.0, float(sample.get("scaleY", 1.0)), amplitude)
		bone.scale = Vector2(rest.scale) * Vector2(scale_x, scale_y)


func _sample_track(track_value, time: float) -> Dictionary:
	if not track_value is Array or track_value.is_empty():
		return {}
	if track_value.size() == 1 or time <= float(track_value[0].get("time", 0.0)):
		return track_value[0]
	if time >= float(track_value[-1].get("time", 0.0)):
		return track_value[-1]
	for index in range(track_value.size() - 1):
		var left: Dictionary = track_value[index]
		var right: Dictionary = track_value[index + 1]
		var left_time := float(left.get("time", 0.0))
		var right_time := float(right.get("time", left_time + 1.0))
		if time < left_time or time > right_time:
			continue
		var amount: float = clamp((time - left_time) / max(0.0001, right_time - left_time), 0.0, 1.0)
		amount = amount * amount * (3.0 - 2.0 * amount)
		var result := {"time": time}
		for key in ["rotation", "x", "y", "scaleX", "scaleY"]:
			var default_value := 1.0 if key in ["scaleX", "scaleY"] else 0.0
			result[key] = lerp(float(left.get(key, default_value)), float(right.get(key, default_value)), amount)
		return result
	return track_value[-1]


func _encode_alpha_video(frames_directory: String) -> Dictionary:
	var format := str(request.output.format)
	var extension := "webm" if format == "transparent-webm" else "mov"
	var output_path := str(request.output.directory).path_join("%s.%s" % [str(request.actorId), extension])
	var ffmpeg_path := str(request.ffmpegPath)
	var args := PackedStringArray([
		"-y", "-framerate", str(request.action.fps),
		"-i", frames_directory.path_join("frame_%06d.png"),
	])
	if format == "transparent-webm":
		args.append_array(PackedStringArray(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "24", "-b:v", "0"]))
	else:
		args.append_array(PackedStringArray(["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]))
	args.append(output_path)
	var output: Array = []
	var exit_code := OS.execute(ffmpeg_path, args, output, true, false)
	if exit_code != 0 or not FileAccess.file_exists(output_path):
		return {"error": "FFmpeg exited with %d: %s" % [exit_code, "\n".join(output).right(2000)]}
	return {"outputPath": output_path}


func _remove_tree(directory: String) -> void:
	if not DirAccess.dir_exists_absolute(directory):
		return
	var dir := DirAccess.open(directory)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while not entry.is_empty():
		if entry != "." and entry != "..":
			var target := directory.path_join(entry)
			if dir.current_is_dir():
				_remove_tree(target)
			else:
				DirAccess.remove_absolute(target)
		entry = dir.get_next()
	dir.list_dir_end()
	DirAccess.remove_absolute(directory)


func _read_json(file_path: String):
	if file_path.is_empty() or not FileAccess.file_exists(file_path):
		return null
	var file := FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		return null
	return JSON.parse_string(file.get_as_text())


func _write_result(result: Dictionary) -> void:
	if result_path.is_empty():
		return
	DirAccess.make_dir_recursive_absolute(result_path.get_base_dir())
	var file := FileAccess.open(result_path, FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(result, "  "))


func _fail(code: String, message: String, exit_code: int) -> void:
	_write_result({
		"protocolVersion": PROTOCOL_VERSION,
		"requestId": str(request.get("requestId", "unknown")),
		"status": "failed",
		"warnings": warnings,
		"error": {"code": code, "message": message},
	})
	get_tree().quit(exit_code)
