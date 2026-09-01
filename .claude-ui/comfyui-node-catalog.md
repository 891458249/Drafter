# 本机 ComfyUI 节点库

- ComfyUI: 0.34.0
- 节点总数: 900
- 分类总数: 201

## 3d (15)

- **Create 3D Animation File** — `BuildPoseFile` · 输入: pose_data, format, fps, camera_translation, track_index, sam3d_body_model · 输出: FILE_3D
- **Create 3D File (from Mesh)** — `MeshToFile3D` · 输入: mesh · 输出: FILE_3D_GLB
- **Create Camera Info** — `CreateCameraInfo` · 输入: mode, target_x, target_y, target_z, roll, fov, zoom, camera_type · 输出: LOAD3D_CAMERA
- **Load 3D (Advanced)** — `Load3DAdvanced` · 输入: model_file, viewport_state, width, height · 输出: FILE_3D, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Load 3D & Animation** — `Load3D` · 输入: model_file, image, width, height · 输出: IMAGE, MASK, STRING, IMAGE, LOAD3D_CAMERA, VIDEO, FILE_3D, LOAD3D_MODEL_INFO
- **Preview 3D (Advanced)** — `Preview3DAdvanced` · 输入: model_3d, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Preview 3D & Animation** — `Preview3D` · 输入: model_file, camera_info, bg_image · 输出: 无
- **Preview Point Cloud** — `PreviewPointCloud` · 输入: model_3d, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D_POINT_CLOUD_ANY, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Preview Splat** — `PreviewGaussianSplat` · 输入: model_3d, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D_SPLAT_ANY, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Save 3D (Advanced)** — `Save3DAdvanced` · 输入: model_3d, filename_prefix, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Save 3D Model** — `SaveGLB` · 输入: mesh, filename_prefix · 输出: 无
- **Save Point Cloud** — `SavePointCloud` · 输入: model_3d, filename_prefix, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D_POINT_CLOUD_ANY, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Save Splat** — `SaveGaussianSplat` · 输入: model_3d, filename_prefix, viewport_state, width, height, model_3d_info, camera_info · 输出: FILE_3D_SPLAT_ANY, LOAD3D_MODEL_INFO, LOAD3D_CAMERA, INT, INT
- **Voxel to Mesh** — `VoxelToMesh` · 输入: voxel, algorithm, threshold · 输出: MESH
- **Voxel to Mesh (Basic) (DEPRECATED)** — `VoxelToMeshBasic` · 输入: voxel, threshold · 输出: MESH

## 3d/mesh (10)

- **Decimate Mesh** — `DecimateMesh` · 输入: mesh, target_face_count, placement_mode · 输出: MESH
- **Fill Holes** — `FillHoles` · 输入: mesh, max_perimeter, weld_epsilon_rel, max_vertices, fill_chains · 输出: MESH
- **Get Mesh Info** — `GetMeshInfo` · 输入: mesh · 输出: MESH, STRING
- **Merge Meshes** — `MergeMeshes` · 输入: meshes · 输出: MESH
- **Paint Mesh** — `PaintMesh` · 输入: mesh, voxel_colors · 输出: MESH
- **Remesh Mesh (Narrow-Band DC)** — `RemeshMesh` · 输入: mesh, resolution, sign_mode, band, project_back, fix_poles, smooth_iters, drop_small_components, precluster_max_verts · 输出: MESH
- **Render Mesh** — `RenderMesh` · 输入: mesh, mode, width, height, background, model_3d_info, camera_info · 输出: IMAGE, MASK
- **Rotate Mesh** — `RotateMesh` · 输入: mesh, mode · 输出: MESH
- **Smooth Mesh Normals** — `MeshSmoothNormals` · 输入: mesh, crease_angle · 输出: MESH
- **Weld Vertices** — `WeldVertices` · 输入: mesh, epsilon_rel, epsilon_abs · 输出: MESH

## 3d/splat (7)

- **Create 3D File (from Splat)** — `SplatToFile3D` · 输入: splat, format · 输出: FILE_3D_SPLAT_ANY
- **Extract Mesh from Splat** — `SplatToMesh` · 输入: splat, resolution, kernel, smooth, level, min_component, min_opacity, color_sharpen · 输出: MESH
- **Get Splat** — `File3DToSplat` · 输入: model_3d · 输出: SPLAT
- **Get Splat Count** — `GetSplatCount` · 输入: splat · 输出: SPLAT, INT
- **Merge Splats** — `MergeSplat` · 输入: splats · 输出: SPLAT
- **Render Splat** — `RenderSplat` · 输入: splat, width, height, frames, splat_scale, sharpen, headlight_shading, opacity_threshold, render_style, background, bg_image, camera_info · 输出: IMAGE, MASK
- **Transform Splat** — `TransformSplat` · 输入: splat, translate_x, translate_y, translate_z, rotate_x, rotate_y, rotate_z, scale_x, scale_y, scale_z · 输出: SPLAT

## 3d/texturing (7)

- **Apply Texture to Mesh** — `ApplyTextureToMesh` · 输入: mesh, base_color, metallic, roughness, occlusion, normal_map · 输出: MESH
- **Bake Ambient Occlusion** — `BakeAmbientOcclusion` · 输入: low_poly, high_poly, resolution, samples, max_distance, strength, bias · 输出: IMAGE
- **Bake Normal Map from Mesh** — `BakeNormalMapFromMesh` · 输入: low_poly, high_poly, resolution, cage_distance, ignore_backfaces · 输出: IMAGE
- **Bake Texture From Voxel** — `BakeTextureFromVoxel` · 输入: mesh, voxel_colors, texture_size, reference_mesh · 输出: IMAGE, IMAGE, IMAGE
- **Mesh Texture to Image** — `MeshTextureToImage` · 输入: mesh · 输出: IMAGE, IMAGE, IMAGE, IMAGE, IMAGE
- **Render UV Atlas** — `RenderUVAtlas` · 输入: mesh, resolution · 输出: IMAGE
- **Unwrap Mesh UVs** — `UnwrapMesh` · 输入: mesh, segmenter, resolution, padding, weld_distance · 输出: MESH

## advanced/debug (3)

- **EasyCache** — `EasyCache` · 输入: model, reuse_threshold, start_percent, end_percent, verbose · 输出: MODEL
- **LazyCache** — `LazyCache` · 输入: model, reuse_threshold, start_percent, end_percent, verbose · 输出: MODEL
- **ModelComputeDtype** — `ModelComputeDtype` · 输入: model, dtype · 输出: MODEL

## advanced/guidance (9)

- **CFGNorm** — `CFGNorm` · 输入: model, strength, pre_cfg · 输出: MODEL
- **CFGZeroStar** — `CFGZeroStar` · 输入: model · 输出: MODEL
- **LTXV Modality Guidance (A/V coupling)** — `LTXVModalityGuidance` · 输入: model, modality_scale, start_percent, end_percent · 输出: MODEL
- **LTXV Spatio-Temporal Guidance (STG)** — `LTXVSpatioTemporalGuidance` · 输入: model, scale, blocks, start_percent, end_percent · 输出: MODEL
- **Normalized Attention Guidance** — `NAGuidance` · 输入: model, nag_scale, nag_alpha, nag_tau · 输出: MODEL
- **SkipLayerGuidanceDiT** — `SkipLayerGuidanceDiT` · 输入: model, double_layers, single_layers, scale, start_percent, end_percent, rescaling_scale · 输出: MODEL
- **SkipLayerGuidanceDiTSimple** — `SkipLayerGuidanceDiTSimple` · 输入: model, double_layers, single_layers, start_percent, end_percent · 输出: MODEL
- **SkipLayerGuidanceSD3** — `SkipLayerGuidanceSD3` · 输入: model, layers, scale, start_percent, end_percent · 输出: MODEL
- **Tangential Damping CFG** — `TCFG` · 输入: model · 输出: MODEL

## advanced/hooks (1)

- **Timesteps Range** — `ConditioningTimestepsRange` · 输入: start_percent, end_percent · 输出: TIMESTEPS_RANGE, TIMESTEPS_RANGE, TIMESTEPS_RANGE

## advanced/hooks/clip (1)

- **Set CLIP Hooks** — `SetClipHooks` · 输入: clip, apply_to_conds, schedule_clip, hooks · 输出: CLIP

## advanced/hooks/combine (3)

- **Combine Hooks [2]** — `CombineHooks2` · 输入: hooks_A, hooks_B · 输出: HOOKS
- **Combine Hooks [4]** — `CombineHooks4` · 输入: hooks_A, hooks_B, hooks_C, hooks_D · 输出: HOOKS
- **Combine Hooks [8]** — `CombineHooks8` · 输入: hooks_A, hooks_B, hooks_C, hooks_D, hooks_E, hooks_F, hooks_G, hooks_H · 输出: HOOKS

## advanced/hooks/cond pair (4)

- **Cond Pair Combine** — `PairConditioningCombine` · 输入: positive_A, negative_A, positive_B, negative_B · 输出: CONDITIONING, CONDITIONING
- **Cond Pair Set Default Combine** — `PairConditioningSetDefaultCombine` · 输入: positive, negative, positive_DEFAULT, negative_DEFAULT, hooks · 输出: CONDITIONING, CONDITIONING
- **Cond Pair Set Props** — `PairConditioningSetProperties` · 输入: positive_NEW, negative_NEW, strength, set_cond_area, mask, hooks, timesteps · 输出: CONDITIONING, CONDITIONING
- **Cond Pair Set Props Combine** — `PairConditioningSetPropertiesAndCombine` · 输入: positive, negative, positive_NEW, negative_NEW, strength, set_cond_area, mask, hooks, timesteps · 输出: CONDITIONING, CONDITIONING

## advanced/hooks/cond single (3)

- **Cond Set Default Combine** — `ConditioningSetDefaultCombine` · 输入: cond, cond_DEFAULT, hooks · 输出: CONDITIONING
- **Cond Set Props** — `ConditioningSetProperties` · 输入: cond_NEW, strength, set_cond_area, mask, hooks, timesteps · 输出: CONDITIONING
- **Cond Set Props Combine** — `ConditioningSetPropertiesAndCombine` · 输入: cond, cond_NEW, strength, set_cond_area, mask, hooks, timesteps · 输出: CONDITIONING

## advanced/hooks/create (4)

- **Create Hook LoRA** — `CreateHookLora` · 输入: lora_name, strength_model, strength_clip, prev_hooks · 输出: HOOKS
- **Create Hook LoRA (MO)** — `CreateHookLoraModelOnly` · 输入: lora_name, strength_model, prev_hooks · 输出: HOOKS
- **Create Hook Model as LoRA** — `CreateHookModelAsLora` · 输入: ckpt_name, strength_model, strength_clip, prev_hooks · 输出: HOOKS
- **Create Hook Model as LoRA (MO)** — `CreateHookModelAsLoraModelOnly` · 输入: ckpt_name, strength_model, prev_hooks · 输出: HOOKS

## advanced/hooks/scheduling (4)

- **Create Hook Keyframe** — `CreateHookKeyframe` · 输入: strength_mult, start_percent, prev_hook_kf · 输出: HOOK_KEYFRAMES
- **Create Hook Keyframes From Floats** — `CreateHookKeyframesFromFloats` · 输入: floats_strength, start_percent, end_percent, print_keyframes, prev_hook_kf · 输出: HOOK_KEYFRAMES
- **Create Hook Keyframes Interp.** — `CreateHookKeyframesInterpolated` · 输入: strength_start, strength_end, interpolation, start_percent, end_percent, keyframes_count, print_keyframes, prev_hook_kf · 输出: HOOK_KEYFRAMES
- **Set Hook Keyframes** — `SetHookKeyframes` · 输入: hooks, hook_kf · 输出: HOOKS

## advanced/multigpu (4)

- **MultiGPU CFG Split** — `MultiGPU_WorkUnits` · 输入: model, max_gpus · 输出: MODEL
- **Select CLIP Device** — `SelectCLIPDevice` · 输入: clip, device · 输出: CLIP
- **Select Model Device** — `SelectModelDevice` · 输入: model, device · 输出: MODEL
- **Select VAE Device** — `SelectVAEDevice` · 输入: vae, device · 输出: VAE

## audio (15)

- **Adjust Audio Volume** — `AudioAdjustVolume` · 输入: audio, volume · 输出: AUDIO
- **Audio Equalizer (3-Band)** — `AudioEqualizer3Band` · 输入: audio, low_gain_dB, low_freq, mid_gain_dB, mid_freq, mid_q, high_gain_dB, high_freq · 输出: AUDIO
- **Concatenate Audio** — `AudioConcat` · 输入: audio1, audio2, direction · 输出: AUDIO
- **Empty Audio** — `EmptyAudio` · 输入: duration, sample_rate, channels · 输出: AUDIO
- **Join Audio Channels** — `JoinAudioChannels` · 输入: audio_left, audio_right · 输出: AUDIO
- **Load Audio** — `LoadAudio` · 输入: audio · 输出: AUDIO
- **Merge Audio** — `AudioMerge` · 输入: audio1, audio2, merge_method · 输出: AUDIO
- **Preview Audio** — `PreviewAudio` · 输入: audio · 输出: AUDIO
- **Record Audio** — `RecordAudio` · 输入: audio · 输出: AUDIO
- **Save Audio (Advanced)** — `SaveAudioAdvanced` · 输入: audio, filename_prefix, format · 输出: AUDIO
- **Save Audio (FLAC) (DEPRECATED)** — `SaveAudio` · 输入: audio, filename_prefix · 输出: AUDIO
- **Save Audio (MP3) (DEPRECATED)** — `SaveAudioMP3` · 输入: audio, filename_prefix, quality · 输出: AUDIO
- **Save Audio (Opus) (DEPRECATED)** — `SaveAudioOpus` · 输入: audio, filename_prefix, quality · 输出: AUDIO
- **Split Audio Channels** — `SplitAudioChannels` · 输入: audio · 输出: AUDIO, AUDIO
- **Trim Audio Duration** — `TrimAudioDuration` · 输入: audio, start_index, duration · 输出: AUDIO

## conditioning/video_models (1)

- **LTXV Duration Predictor** — `LTXVDurationPredictor` · 输入: model, positive, duration_head, frame_rate, min_seconds, max_seconds · 输出: INT, FLOAT

## dataset/video (1)

- **Shuffle Pairs of Video-Text** — `ShuffleVideoTextDataset` · 输入: videos, texts, seed · 输出: VIDEO, STRING

## experimental (11)

- **Differential Diffusion** — `DifferentialDiffusion` · 输入: model, strength · 输出: MODEL
- **Extract and Save Lora** — `LoraSave` · 输入: filename_prefix, rank, lora_type, bias_diff, model_diff, text_encoder_diff · 输出: 无
- **Flux KV Cache** — `FluxKVCache` · 输入: model · 输出: MODEL
- **FreSca** — `FreSca` · 输入: model, scale_low, scale_high, freq_cutoff · 输出: MODEL
- **Latent Blend** — `LatentBlend` · 输入: samples1, samples2, blend_factor · 输出: LATENT
- **Perp-Neg (DEPRECATED by Perp-Neg Guider)** — `PerpNeg` · 输入: model, empty_conditioning, neg_scale · 输出: MODEL
- **Perp-Neg Guider** — `PerpNegGuider` · 输入: model, positive, negative, empty_conditioning, cfg, neg_scale · 输出: GUIDER
- **Positive-Biased Guidance** — `Mahiro` · 输入: model · 输出: MODEL
- **SamplerEulerCFG++** — `SamplerEulerCFGpp` · 输入: version · 输出: SAMPLER
- **Self-Attention Guidance** — `SelfAttentionGuidance` · 输入: model, scale, blur_sigma · 输出: MODEL
- **TorchCompileModel** — `TorchCompileModel` · 输入: model, backend · 输出: MODEL

## experimental/attention_experiments (4)

- **CLIPAttentionMultiply** — `CLIPAttentionMultiply` · 输入: clip, q, k, v, out · 输出: CLIP
- **UNetCrossAttentionMultiply** — `UNetCrossAttentionMultiply` · 输入: model, q, k, v, out · 输出: MODEL
- **UNetSelfAttentionMultiply** — `UNetSelfAttentionMultiply` · 输入: model, q, k, v, out · 输出: MODEL
- **UNetTemporalAttentionMultiply** — `UNetTemporalAttentionMultiply` · 输入: model, self_structural, self_temporal, cross_structural, cross_temporal · 输出: MODEL

## experimental/stable cascade (1)

- **StableCascade_SuperResolutionControlnet** — `StableCascade_SuperResolutionControlnet` · 输入: image, vae · 输出: IMAGE, LATENT, LATENT

## image (22)

- **Add Layer** — `AddLayer` · 输入: image, layers, mask, name, x, y, opacity, blend_mode, rotation, width, height, z_index, flip_h, flip_v · 输出: LAYERS
- **Compare Images** — `ImageCompare` · 输入: compare_view, image_a, image_b · 输出: 无
- **Create Layered Image** — `ImageCompositor` · 输入: layers, compositor · 输出: IMAGE, MASK
- **Empty Image** — `EmptyImage` · 输入: width, height, batch_size, color · 输出: IMAGE
- **Get Image Size** — `GetImageSize` · 输入: image · 输出: INT, INT, INT
- **Layers From Bounding Boxes** — `LayersFromBoundingBoxes` · 输入: image, bboxes, mask, layers, crop_to_content, canvas_width, canvas_height · 输出: LAYERS
- **Load Image** — `LoadImage` · 输入: image · 输出: IMAGE, MASK
- **Load Image (as Mask)** — `LoadImageMask` · 输入: image, channel · 输出: MASK
- **Load Image (from Folder)** — `LoadImageDataSetFromFolder` · 输入: folder · 输出: IMAGE
- **Load Image (from Outputs)** — `LoadImageOutput` · 输入: image · 输出: IMAGE, MASK
- **Load Image-Text (from Folder)** — `LoadImageTextDataSetFromFolder` · 输入: folder · 输出: IMAGE, STRING
- **Painter** — `Painter` · 输入: mask, width, height, bg_color, image · 输出: IMAGE, MASK
- **Preview Image** — `PreviewImage` · 输入: images · 输出: IMAGE
- **Save Animated PNG** — `SaveAnimatedPNG` · 输入: images, filename_prefix, fps, compress_level · 输出: IMAGE
- **Save Animated WEBP** — `SaveAnimatedWEBP` · 输入: images, filename_prefix, fps, lossless, quality, method · 输出: IMAGE
- **Save Image** — `SaveImage` · 输入: images, filename_prefix · 输出: IMAGE
- **Save Image (Advanced)** — `SaveImageAdvanced` · 输入: images, filename_prefix, format · 输出: IMAGE
- **Save Image (to Folder) (DEPRECATED)** — `SaveImageDataSetToFolder` · 输入: images, folder_name, filename_prefix, mode · 输出: 无
- **Save Image (Websocket)** — `SaveImageWebsocket` · 输入: images · 输出: 无
- **Save Image-Text (to Folder)** — `SaveImageTextDataSetToFolder` · 输入: images, folder_name, filename_prefix, mode, texts · 输出: 无
- **Save SVG** — `SaveSVGNode` · 输入: svg, filename_prefix · 输出: SVG
- **Webcam Capture** — `WebcamCapture` · 输入: image, width, height, capture_on_queue · 输出: IMAGE

## image/adjustments (2)

- **Adjust Brightness** — `AdjustBrightness` · 输入: images, factor · 输出: IMAGE
- **Adjust Contrast** — `AdjustContrast` · 输入: images, factor · 输出: IMAGE

## image/background removal (1)

- **Remove Background** — `RemoveBackground` · 输入: bg_removal_model, image · 输出: MASK

## image/batch (12)

- **Batch Images** — `BatchImagesNode` · 输入: images · 输出: IMAGE
- **Batch Images (DEPRECATED)** — `ImageBatch` · 输入: image1, image2 · 输出: IMAGE
- **Deduplicate Images** — `ImageDeduplication` · 输入: images, similarity_threshold · 输出: IMAGE
- **Get Image from Batch** — `ImageFromBatch` · 输入: image, batch_index, length · 输出: IMAGE
- **Make Image Grid** — `ImageGrid` · 输入: images, columns, cell_width, cell_height, padding · 输出: IMAGE
- **Merge Image Lists (DEPRECATED)** — `MergeImageLists` · 输入: images · 输出: IMAGE
- **Merge List of Tiles to Image** — `ImageMergeTileList` · 输入: image_list, final_width, final_height, overlap · 输出: IMAGE
- **Rebatch Images** — `RebatchImages` · 输入: images, batch_size · 输出: IMAGE
- **Repeat Image Batch** — `RepeatImageBatch` · 输入: image, amount · 输出: IMAGE
- **Shuffle Images List** — `ShuffleDataset` · 输入: images, seed · 输出: IMAGE
- **Shuffle Pairs of Image-Text** — `ShuffleImageTextDataset` · 输入: images, texts, seed · 输出: IMAGE, STRING
- **Split Image into List of Tiles** — `SplitImageToTileList` · 输入: image, tile_width, tile_height, overlap · 输出: IMAGE

## image/color (4)

- **Image RGB to YUV** — `ImageRGBToYUV` · 输入: image · 输出: IMAGE, IMAGE, IMAGE
- **Image YUV to RGB** — `ImageYUVToRGB` · 输入: Y, U, V · 输出: IMAGE
- **Invert Image Colors** — `ImageInvert` · 输入: image · 输出: IMAGE
- **Normalize Image Colors** — `NormalizeImages` · 输入: images, mean, std · 输出: IMAGE

## image/compositing (4)

- **Image Composite Masked** — `ImageCompositeMasked` · 输入: destination, source, x, y, resize_source, mask · 输出: IMAGE
- **Join Image with Alpha** — `JoinImageWithAlpha` · 输入: image, alpha · 输出: IMAGE
- **Porter-Duff Image Composite** — `PorterDuffImageComposite` · 输入: source, source_alpha, destination, destination_alpha, mode · 输出: IMAGE, MASK
- **Split Image with Alpha** — `SplitImageWithAlpha` · 输入: image · 输出: IMAGE, MASK

## image/detection (17)

- **Detect Face Landmarks (MediaPipe)** — `MediaPipeFaceLandmarker` · 输入: face_detection_model, image, detector_variant, num_faces, min_confidence, missing_frame_fallback · 输出: FACE_LANDMARKS, BOUNDING_BOX
- **Draw BBoxes** — `DrawBBoxes` · 输入: bboxes, image · 输出: IMAGE
- **Draw Face Mask (MediaPipe)** — `MediaPipeFaceMask` · 输入: face_landmarks, regions · 输出: MASK
- **Face Expression to SAM3D Body** — `SAM3DBody_FaceExpression` · 输入: sam3d_body_model, mhr_pose_data, image, strength, mouth_strength, eye_strength, brow_strength, input_threshold, blendshape_smooth_window · 输出: MHR_POSE_DATA
- **Load SAM3D Body Model** — `SAM3DBody_Loader` · 输入: model_file · 输出: SAM3D_BODY_MODEL
- **Render 3D Body Pose** — `SAM3DBody_Render` · 输入: pose_data, width, height, render_style, background, camera_info · 输出: IMAGE
- **Run Real-Time Detection (RT-DETR)** — `RTDETR_detect` · 输入: model, image, threshold, class_name, max_detections · 输出: BOUNDING_BOX
- **Run SAM3 Video Track** — `SAM3_VideoTrack` · 输入: images, model, detection_threshold, max_objects, detect_interval, initial_mask, conditioning · 输出: SAM3_TRACK_DATA
- **Run SAM3D Body Prediction** — `SAM3DBody_Predict` · 输入: sam3d_body_model, image, run_hand_refinement, fov, batch_size, track_data, bboxes · 输出: MHR_POSE_DATA
- **SAM3 Detect** — `SAM3_Detect` · 输入: model, image, threshold, refine_iterations, individual_masks, conditioning, bboxes, positive_coords, negative_coords · 输出: MASK, BOUNDING_BOX
- **SAM3 Track Preview** — `SAM3_TrackPreview` · 输入: track_data, opacity, fps, images · 输出: 无
- **SAM3 Track to Mask** — `SAM3_TrackToMask` · 输入: track_data, object_indices · 输出: MASK
- **SDPose Draw Keypoints** — `SDPoseDrawKeypoints` · 输入: keypoints, draw_body, draw_hands, draw_face, draw_feet, stick_width, face_point_size, score_threshold, draw_head · 输出: IMAGE
- **SDPose Face Bounding Boxes** — `SDPoseFaceBBoxes` · 输入: keypoints, scale, force_square · 输出: BOUNDING_BOX
- **SDPose Keypoint Extractor** — `SDPoseKeypointExtractor` · 输入: model, vae, image, batch_size, bboxes · 输出: POSE_KEYPOINT
- **Smooth SAM3D Body Pose Data** — `SAM3DBody_Smooth` · 输入: mhr_pose_data, strength, method, window, rotation_threshold_degrees · 输出: MHR_POSE_DATA
- **Visualize Face Landmarks (MediaPipe)** — `MediaPipeFaceMeshVisualize` · 输入: face_landmarks, connections, color, thickness, point_size, image · 输出: IMAGE

## image/filters (8)

- **Add Noise to Image** — `ImageAddNoise` · 输入: image, seed, strength · 输出: IMAGE
- **Apply Morphology** — `Morphology` · 输入: image, operation, kernel_size · 输出: IMAGE
- **Blend Images** — `ImageBlend` · 输入: image1, image2, blend_factor, blend_mode · 输出: IMAGE
- **Blur Image** — `ImageBlur` · 输入: image, blur_radius, sigma · 输出: IMAGE
- **Detect Edges (Canny)** — `Canny` · 输入: image, low_threshold, high_threshold · 输出: IMAGE
- **Quantize Image** — `ImageQuantize` · 输入: image, colors, dither · 输出: IMAGE
- **Sharpen Image** — `ImageSharpen` · 输入: image, sharpen_radius, sigma, alpha · 输出: IMAGE
- **Transfer Color** — `ColorTransfer` · 输入: image_target, image_ref, method, source_stats, strength · 输出: IMAGE

## image/geometry estimation (8)

- **Convert DA3 Geometry to Mesh** — `DA3GeometryToMesh` · 输入: da3_geometry, batch_index, decimation, discontinuity_threshold, confidence_threshold, use_sky_mask, texture · 输出: MESH
- **Convert MoGe Point Map to Mesh** — `MoGePointMapToMesh` · 输入: moge_geometry, batch_index, decimation, discontinuity_threshold, texture · 输出: MESH
- **Get FoV from MoGe Geometry** — `MoGeGeometryToFOV` · 输入: moge_geometry, axis, unit · 输出: FLOAT, FLOAT
- **Render Depth Anything 3** — `DA3Render` · 输入: da3_geometry, output · 输出: IMAGE
- **Render MoGe Geometry** — `MoGeRender` · 输入: moge_geometry, output · 输出: IMAGE
- **Run Depth Anything 3** — `DA3Inference` · 输入: da3_model, image, resolution, resize_method, mode · 输出: DA3_GEOMETRY
- **Run MoGe Inference** — `MoGeInference` · 输入: moge_model, image, resolution_level, fov_x_degrees, batch_size, force_projection, apply_mask · 输出: MOGE_GEOMETRY
- **Run MoGe Panorama Inference** — `MoGePanoramaInference` · 输入: moge_model, image, resolution_level, split_resolution, merge_resolution, batch_size · 输出: MOGE_GEOMETRY

## image/mask (13)

- **Batch Masks** — `BatchMasksNode` · 输入: masks · 输出: MASK
- **Combine Masks** — `MaskComposite` · 输入: destination, source, x, y, operation · 输出: MASK
- **Convert Image Color to Mask** — `ImageColorToMask` · 输入: image, color · 输出: MASK
- **Convert Image to Mask** — `ImageToMask` · 输入: image, channel · 输出: MASK
- **Convert Mask to Image** — `MaskToImage` · 输入: mask · 输出: IMAGE
- **Create Solid Mask** — `SolidMask` · 输入: value, width, height · 输出: MASK
- **Crop Mask** — `CropMask` · 输入: mask, x, y, width, height · 输出: MASK
- **Feather Mask** — `FeatherMask` · 输入: mask, left, top, right, bottom · 输出: MASK
- **Grow Mask** — `GrowMask` · 输入: mask, expand, tapered_corners · 输出: MASK
- **Invert Mask** — `InvertMask` · 输入: mask · 输出: MASK
- **Preview Mask** — `MaskPreview` · 输入: mask · 输出: MASK
- **Threshold Mask** — `ThresholdMask` · 输入: mask, value · 输出: MASK
- **VOID Quadmask Preprocessor** — `VOIDQuadmaskPreprocess` · 输入: mask, dilate_width · 输出: MASK

## image/post-processors (1)

- **Post-Process SeedVR2 Output** — `SeedVR2PostProcessing` · 输入: images, original_resized_images, color_correction_method · 输出: IMAGE

## image/pre-processors (1)

- **Pre-Process SeedVR2 Input** — `SeedVR2Preprocess` · 输入: resized_images · 输出: IMAGE

## image/shader (1)

- **GLSL Shader** — `GLSLShader` · 输入: fragment_shader, size_mode, images, floats, ints, bools, curves · 输出: IMAGE, IMAGE, IMAGE, IMAGE

## image/transform (14)

- **Crop By Bounding Boxes** — `CropByBBoxes` · 输入: image, bboxes, output_width, output_height, padding, keep_aspect · 输出: IMAGE
- **Crop Image** — `ImageCropV2` · 输入: image, crop_region · 输出: IMAGE
- **Crop Image (Center)** — `CenterCropImages` · 输入: images, width, height · 输出: IMAGE
- **Crop Image (DEPRECATED)** — `ImageCrop` · 输入: image, width, height, x, y · 输出: IMAGE
- **Crop Image (Random)** — `RandomCropImages` · 输入: images, width, height, seed · 输出: IMAGE
- **Crop Image to Mask** — `ImageCropToMask` · 输入: images, masks, width, height, pad_factor, grow_mask, background · 输出: IMAGE
- **Flip Image** — `ImageFlip` · 输入: image, flip_method · 输出: IMAGE
- **Pad Image for Outpainting** — `ImagePadForOutpaint` · 输入: image, left, top, right, bottom, feathering · 输出: IMAGE, MASK
- **Resize And Pad Image** — `ResizeAndPadImage` · 输入: image, target_width, target_height, padding_color, interpolation · 输出: IMAGE
- **Resize Image/Mask** — `ResizeImageMaskNode` · 输入: input, resize_type, scale_method · 输出: COMFY_MATCHTYPE_V3
- **Resize Images by Longer Edge (DEPRECATED)** — `ResizeImagesByLongerEdge` · 输入: images, longer_edge · 输出: IMAGE
- **Resize Images by Shorter Edge (DEPRECATED)** — `ResizeImagesByShorterEdge` · 输入: images, shorter_edge · 输出: IMAGE
- **Rotate Image** — `ImageRotate` · 输入: image, rotation · 输出: IMAGE
- **Stitch Images** — `ImageStitch` · 输入: image1, direction, match_image_size, spacing_width, spacing_color, image2 · 输出: IMAGE

## image/upscaling (5)

- **Scale Image to Max Dimension** — `ImageScaleToMaxDimension` · 输入: image, upscale_method, largest_size · 输出: IMAGE
- **Scale Image to Total Pixels** — `ImageScaleToTotalPixels` · 输入: image, upscale_method, megapixels, resolution_steps · 输出: IMAGE
- **Upscale Image** — `ImageScale` · 输入: image, upscale_method, width, height, crop · 输出: IMAGE
- **Upscale Image (using Model)** — `ImageUpscaleWithModel` · 输入: upscale_model, image · 输出: IMAGE
- **Upscale Image By** — `ImageScaleBy` · 输入: image, upscale_method, scale_by · 输出: IMAGE

## image/video (2)

- **WanDancerPadKeyframes** — `WanDancerPadKeyframes` · 输入: images, segment_length, segment_index, audio · 输出: IMAGE, MASK, AUDIO
- **WanDancerPadKeyframesList** — `WanDancerPadKeyframesList` · 输入: images, segment_length, num_segments, audio · 输出: IMAGE, MASK, AUDIO

## model_patches/anima (1)

- **Apply Anima LLLite** — `AnimaLLLiteApply` · 输入: model, model_patch, image, strength, start_percent, end_percent, mask · 输出: MODEL

## model/conditioning (14)

- **Apply SeedVR2 Conditioning** — `SeedVR2Conditioning` · 输入: model, vae_conditioning · 输出: CONDITIONING, CONDITIONING
- **Apply Style Model** — `StyleModelApply` · 输入: conditioning, style_model, clip_vision_output, strength, strength_type · 输出: CONDITIONING
- **AudioEncoderEncode** — `AudioEncoderEncode` · 输入: audio_encoder, audio · 输出: AUDIO_ENCODER_OUTPUT
- **CLIP Set Last Layer** — `CLIPSetLastLayer` · 输入: clip, stop_at_clip_layer · 输出: CLIP
- **CLIP Text Encode (Controlnet)** — `CLIPTextEncodeControlnet` · 输入: clip, conditioning, text · 输出: CONDITIONING
- **CLIP Text Encode (Prompt)** — `CLIPTextEncode` · 输入: text, clip · 输出: CONDITIONING
- **CLIP Vision Encode** — `CLIPVisionEncode` · 输入: clip_vision, image, crop · 输出: CLIP_VISION_OUTPUT
- **InpaintModelConditioning** — `InpaintModelConditioning` · 输入: positive, negative, vae, pixels, mask, noise_mask · 输出: CONDITIONING, CONDITIONING, LATENT
- **NormalizeVideoLatentStart** — `NormalizeVideoLatentStart` · 输入: latent, start_frame_count, reference_frame_count · 输出: LATENT
- **PiD Conditioning** — `PiDConditioning` · 输入: positive, latent, latent_format, degrade_sigma · 输出: CONDITIONING
- **Set Reference Audio** — `ReferenceTimbreAudio` · 输入: conditioning, latent · 输出: CONDITIONING
- **Set Reference Latent** — `ReferenceLatent` · 输入: conditioning, latent · 输出: CONDITIONING
- **T5 Tokenizer Options** — `T5TokenizerOptions` · 输入: clip, min_padding, min_length · 输出: CLIP
- **unCLIPConditioning** — `unCLIPConditioning` · 输入: conditioning, clip_vision_output, strength, noise_augmentation · 输出: CONDITIONING

## model/conditioning/ace (2)

- **TextEncodeAceStepAudio** — `TextEncodeAceStepAudio` · 输入: clip, tags, lyrics, lyrics_strength · 输出: CONDITIONING
- **TextEncodeAceStepAudio1.5** — `TextEncodeAceStepAudio1.5` · 输入: clip, tags, lyrics, seed, bpm, duration, timesignature, language, keyscale, generate_audio_codes, cfg_scale, temperature, top_p, top_k, min_p · 输出: CONDITIONING

## model/conditioning/autoregressive (1)

- **ARVideoI2V** — `ARVideoI2V` · 输入: model, vae, start_image, width, height, length, batch_size · 输出: MODEL, LATENT

## model/conditioning/bernini (1)

- **Bernini Conditioning** — `BerniniConditioning` · 输入: positive, negative, vae, width, height, length, batch_size, source_video, reference_video, reference_images, ref_max_size · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/boogu (1)

- **TextEncodeBooguEdit** — `TextEncodeBooguEdit` · 输入: clip, prompt, negative_prompt, vae, images · 输出: CONDITIONING, CONDITIONING

## model/conditioning/controlnet (5)

- **Apply ControlNet** — `ControlNetApplyAdvanced` · 输入: positive, negative, control_net, image, strength, start_percent, end_percent, vae · 输出: CONDITIONING, CONDITIONING
- **Apply ControlNet (DEPRECATED)** — `ControlNetApply` · 输入: conditioning, control_net, image, strength · 输出: CONDITIONING
- **Apply ControlNet Inpainting (AliMama)** — `ControlNetInpaintingAliMamaApply` · 输入: positive, negative, control_net, vae, image, mask, strength, start_percent, end_percent · 输出: CONDITIONING, CONDITIONING
- **Apply Controlnet with VAE** — `ControlNetApplySD3` · 输入: positive, negative, control_net, vae, image, strength, start_percent, end_percent · 输出: CONDITIONING, CONDITIONING
- **Set Union ControlNet Type** — `SetUnionControlNetType` · 输入: control_net, type · 输出: CONTROL_NET

## model/conditioning/cosmos (2)

- **CosmosImageToVideoLatent** — `CosmosImageToVideoLatent` · 输入: vae, width, height, length, batch_size, start_image, end_image · 输出: LATENT
- **CosmosPredict2ImageToVideoLatent** — `CosmosPredict2ImageToVideoLatent` · 输入: vae, width, height, length, batch_size, start_image, end_image · 输出: LATENT

## model/conditioning/flux (5)

- **CLIPTextEncodeFlux** — `CLIPTextEncodeFlux` · 输入: clip, clip_l, t5xxl, guidance · 输出: CONDITIONING
- **Edit Model Reference Method** — `FluxKontextMultiReferenceLatentMethod` · 输入: conditioning, reference_latents_method · 输出: CONDITIONING
- **FluxDisableGuidance** — `FluxDisableGuidance` · 输入: conditioning · 输出: CONDITIONING
- **FluxGuidance** — `FluxGuidance` · 输入: conditioning, guidance · 输出: CONDITIONING
- **FluxKontextImageScale** — `FluxKontextImageScale` · 输入: image · 输出: IMAGE

## model/conditioning/gligen (1)

- **Apply GLIGEN Text Box** — `GLIGENTextBoxApply` · 输入: conditioning_to, clip, gligen_textbox_model, text, width, height, x, y · 输出: CONDITIONING

## model/conditioning/hidream (2)

- **CLIP Text Encode (HiDream)** — `CLIPTextEncodeHiDream` · 输入: clip, clip_l, clip_g, t5xxl, llama · 输出: CONDITIONING
- **HiDream-O1 Reference Images** — `HiDreamO1ReferenceImages` · 输入: positive, negative, images · 输出: CONDITIONING, CONDITIONING

## model/conditioning/hunyuan 3d (2)

- **Hunyuan3Dv2Conditioning** — `Hunyuan3Dv2Conditioning` · 输入: clip_vision_output · 输出: CONDITIONING, CONDITIONING
- **Hunyuan3Dv2ConditioningMultiView** — `Hunyuan3Dv2ConditioningMultiView` · 输入: front, left, back, right · 输出: CONDITIONING, CONDITIONING

## model/conditioning/hunyuan image (1)

- **CLIP Text Encode (Hunyuan Image)** — `CLIPTextEncodeHunyuanDiT` · 输入: clip, bert, mt5xl · 输出: CONDITIONING

## model/conditioning/hunyuan video (5)

- **Hunyuan Latent Refiner** — `HunyuanRefinerLatent` · 输入: positive, negative, latent, noise_augmentation · 输出: CONDITIONING, CONDITIONING, LATENT
- **Hunyuan Video 1.5 Super Resolution** — `HunyuanVideo15SuperResolution` · 输入: positive, negative, latent, noise_augmentation, vae, start_image, clip_vision_output · 输出: CONDITIONING, CONDITIONING, LATENT
- **HunyuanImageToVideo** — `HunyuanImageToVideo` · 输入: positive, vae, width, height, length, batch_size, guidance_type, start_image · 输出: CONDITIONING, LATENT
- **HunyuanVideo15ImageToVideo** — `HunyuanVideo15ImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, start_image, clip_vision_output · 输出: CONDITIONING, CONDITIONING, LATENT
- **TextEncodeHunyuanVideo_ImageToVideo** — `TextEncodeHunyuanVideo_ImageToVideo` · 输入: clip, clip_vision_output, prompt, image_interleave · 输出: CONDITIONING

## model/conditioning/instructpix2pix (1)

- **InstructPixToPixConditioning** — `InstructPixToPixConditioning` · 输入: positive, negative, vae, pixels · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/joyimage (1)

- **TextEncodeJoyImageEdit** — `TextEncodeJoyImageEdit` · 输入: clip, prompt, vae, images · 输出: CONDITIONING

## model/conditioning/kandinsky (2)

- **CLIP Text Encode (Kandinsky 5)** — `CLIPTextEncodeKandinsky5` · 输入: clip, clip_l, qwen25_7b · 输出: CONDITIONING
- **Kandinsky5ImageToVideo** — `Kandinsky5ImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, start_image · 输出: CONDITIONING, CONDITIONING, LATENT, LATENT

## model/conditioning/lotus (1)

- **LotusConditioning** — `LotusConditioning` · 输入: 无 · 输出: CONDITIONING

## model/conditioning/ltxv (7)

- **Get IC-LoRA Parameters** — `GetICLoRAParameters` · 输入: iclora_model · 输出: IC_LORA_PARAMETERS
- **LTXV Reference Audio (ID-LoRA)** — `LTXVReferenceAudio` · 输入: model, positive, negative, reference_audio, audio_vae, identity_guidance_scale, start_percent, end_percent · 输出: MODEL, CONDITIONING, CONDITIONING
- **LTXVAddGuide** — `LTXVAddGuide` · 输入: positive, negative, vae, latent, image, frame_idx, strength, attention_mask, iclora_parameters · 输出: CONDITIONING, CONDITIONING, LATENT
- **LTXVConditioning** — `LTXVConditioning` · 输入: positive, negative, frame_rate · 输出: CONDITIONING, CONDITIONING
- **LTXVCropGuides** — `LTXVCropGuides` · 输入: positive, negative, latent · 输出: CONDITIONING, CONDITIONING, LATENT
- **LTXVImgToVideo** — `LTXVImgToVideo` · 输入: positive, negative, vae, image, width, height, length, batch_size, strength · 输出: CONDITIONING, CONDITIONING, LATENT
- **LTXVImgToVideoInplace** — `LTXVImgToVideoInplace` · 输入: vae, image, latent, strength, bypass · 输出: LATENT

## model/conditioning/lumina (1)

- **CLIP Text Encode (Lumina 2)** — `CLIPTextEncodeLumina2` · 输入: system_prompt, user_prompt, clip · 输出: CONDITIONING

## model/conditioning/mage (1)

- **TextEncodeMageFlowEdit** — `TextEncodeMageFlowEdit` · 输入: clip, prompt, negative_prompt, images, width, height, batch_size, vae · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/minimax (3)

- **Add Guide for MiniMax H3** — `MiniMaxH3AddGuide` · 输入: positive, latent, frame_idx, vae, audio_vae, image, audio · 输出: CONDITIONING
- **MiniMax H3 Image to Video** — `MiniMaxH3ImageToVideo` · 输入: clip, vae, prompt, width, height, length, first_frame, last_frame · 输出: CONDITIONING, LATENT
- **MiniMax H3 Reference to Video** — `MiniMaxH3ReferenceToVideo` · 输入: clip, vae, audio_vae, prompt, width, height, length, ref_image_size, ref_images, ref_videos, ref_video_audios, ref_audios · 输出: CONDITIONING, LATENT

## model/conditioning/minimax music (1)

- **MiniMax Music3 Text Encode** — `MiniMaxMusic3TextEncode` · 输入: clip, caption, lyrics, seed, max_duration, cfg_scale, top_k · 输出: CONDITIONING, FLOAT

## model/conditioning/photomaker (1)

- **PhotoMaker Encode** — `PhotoMakerEncode` · 输入: photomaker, image, clip, text · 输出: CONDITIONING

## model/conditioning/pixart (1)

- **CLIP Text Encode (PixArt Alpha)** — `CLIPTextEncodePixArtAlpha` · 输入: width, height, text, clip · 输出: CONDITIONING

## model/conditioning/qwen image (2)

- **TextEncodeQwenImageEdit** — `TextEncodeQwenImageEdit` · 输入: clip, prompt, vae, image · 输出: CONDITIONING
- **TextEncodeQwenImageEditPlus** — `TextEncodeQwenImageEditPlus` · 输入: clip, prompt, vae, image1, image2, image3 · 输出: CONDITIONING

## model/conditioning/stable audio (1)

- **ConditioningStableAudio** — `ConditioningStableAudio` · 输入: positive, negative, seconds_start, seconds_total · 输出: CONDITIONING, CONDITIONING

## model/conditioning/stable cascade (1)

- **StableCascade_StageB_Conditioning** — `StableCascade_StageB_Conditioning` · 输入: conditioning, stage_c · 输出: CONDITIONING

## model/conditioning/stable diffusion (3)

- **CLIP Text Encode (SD3)** — `CLIPTextEncodeSD3` · 输入: clip, clip_l, clip_g, t5xxl, empty_padding · 输出: CONDITIONING
- **CLIP Text Encode (SDXL Refiner)** — `CLIPTextEncodeSDXLRefiner` · 输入: ascore, width, height, text, clip · 输出: CONDITIONING
- **CLIP Text Encode (SDXL)** — `CLIPTextEncodeSDXL` · 输入: clip, width, height, crop_w, crop_h, target_width, target_height, text_g, text_l · 输出: CONDITIONING

## model/conditioning/stable diffusion upscaler (1)

- **SD_4XUpscale_Conditioning** — `SD_4XUpscale_Conditioning` · 输入: images, positive, negative, scale_ratio, noise_augmentation · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/stable video (1)

- **SVD_img2vid_Conditioning** — `SVD_img2vid_Conditioning` · 输入: clip_vision, init_image, vae, width, height, video_frames, motion_bucket_id, fps, augmentation_level · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/stable video 3d (1)

- **SV3D_Conditioning** — `SV3D_Conditioning` · 输入: clip_vision, init_image, vae, width, height, video_frames, elevation · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/stable zero123 (2)

- **StableZero123_Conditioning** — `StableZero123_Conditioning` · 输入: clip_vision, init_image, vae, width, height, batch_size, elevation, azimuth · 输出: CONDITIONING, CONDITIONING, LATENT
- **StableZero123_Conditioning_Batched** — `StableZero123_Conditioning_Batched` · 输入: clip_vision, init_image, vae, width, height, batch_size, elevation, azimuth, elevation_batch_increment, azimuth_batch_increment · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/transform (11)

- **Conditioning (Average)** — `ConditioningAverage` · 输入: conditioning_to, conditioning_from, conditioning_to_strength · 输出: CONDITIONING
- **Conditioning (Combine)** — `ConditioningCombine` · 输入: conditioning_1, conditioning_2 · 输出: CONDITIONING
- **Conditioning (Concat)** — `ConditioningConcat` · 输入: conditioning_to, conditioning_from · 输出: CONDITIONING
- **Conditioning (Multiply)** — `ConditioningMultiply` · 输入: conditioning, multiplier · 输出: CONDITIONING
- **Conditioning (Set Area Strength)** — `ConditioningSetAreaStrength` · 输入: conditioning, strength · 输出: CONDITIONING
- **Conditioning (Set Area with Percentage for Video)** — `ConditioningSetAreaPercentageVideo` · 输入: conditioning, width, height, temporal, x, y, z, strength · 输出: CONDITIONING
- **Conditioning (Set Area with Percentage)** — `ConditioningSetAreaPercentage` · 输入: conditioning, width, height, x, y, strength · 输出: CONDITIONING
- **Conditioning (Set Area)** — `ConditioningSetArea` · 输入: conditioning, width, height, x, y, strength · 输出: CONDITIONING
- **Conditioning (Set Mask)** — `ConditioningSetMask` · 输入: conditioning, mask, strength, set_cond_area · 输出: CONDITIONING
- **Conditioning Zero Out** — `ConditioningZeroOut` · 输入: conditioning · 输出: CONDITIONING
- **ConditioningSetTimestepRange** — `ConditioningSetTimestepRange` · 输入: conditioning, start, end · 输出: CONDITIONING

## model/conditioning/trellis2 (5)

- **Pixal3DConditioning** — `Pixal3DConditioning` · 输入: clip_vision_model, image, camera_angle_x · 输出: CONDITIONING, CONDITIONING
- **Trellis2 Upsample Stage** — `Trellis2UpsampleStage` · 输入: positive, negative, shape_latent, vae, target_resolution · 输出: CONDITIONING, CONDITIONING, LATENT
- **Trellis2Conditioning** — `Trellis2Conditioning` · 输入: clip_vision_model, image · 输出: CONDITIONING, CONDITIONING
- **Trellis2ShapeStage** — `Trellis2ShapeStage` · 输入: positive, negative, voxel · 输出: CONDITIONING, CONDITIONING, LATENT
- **Trellis2TextureStage** — `Trellis2TextureStage` · 输入: positive, negative, shape_latent · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/triposplat (2)

- **TripoSplat Conditioning** — `TripoSplatConditioning` · 输入: clip_vision, vae, image · 输出: CONDITIONING, CONDITIONING, LATENT
- **TripoSplat Preprocess Image** — `TripoSplatPreprocessImage` · 输入: image, mask, erode_radius, size · 输出: IMAGE

## model/conditioning/void (1)

- **VOIDInpaintConditioning** — `VOIDInpaintConditioning` · 输入: positive, negative, vae, video, quadmask, width, height, length, batch_size · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan (3)

- **Wan22ImageToVideoLatent** — `Wan22ImageToVideoLatent` · 输入: vae, width, height, length, batch_size, start_image · 输出: LATENT
- **WanFirstLastFrameToVideo** — `WanFirstLastFrameToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, clip_vision_start_image, clip_vision_end_image, start_image, end_image · 输出: CONDITIONING, CONDITIONING, LATENT
- **WanImageToVideo** — `WanImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, clip_vision_output, start_image · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/animate (3)

- **WanAnimate2Cache** — `WanAnimate2Cache` · 输入: model, device, dtype · 输出: MODEL
- **WanAnimate2ToVideo** — `WanAnimate2ToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, video_frame_offset, pose_strength, pose_start_percent, pose_end_percent, reference_image_strength, reference_image, pose_video, clip_vision_output, positive_pose, clip_vision_output_pose, continue_motion · 输出: CONDITIONING, CONDITIONING, LATENT, INT, INT, INT
- **WanAnimateToVideo** — `WanAnimateToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, continue_motion_max_frames, video_frame_offset, clip_vision_output, reference_image, face_video, pose_video, background_video, character_mask, continue_motion · 输出: CONDITIONING, CONDITIONING, LATENT, INT, INT, INT

## model/conditioning/wan/camera (2)

- **WanCameraEmbedding** — `WanCameraEmbedding` · 输入: camera_pose, width, height, length, speed, fx, fy, cx, cy · 输出: WAN_CAMERA_EMBEDDING, INT, INT, INT
- **WanCameraImageToVideo** — `WanCameraImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, clip_vision_output, start_image, camera_conditions · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/dancer (2)

- **WanDancerEncodeAudio** — `WanDancerEncodeAudio` · 输入: audio, video_frames, audio_inject_scale · 输出: AUDIO_ENCODER_OUTPUT, STRING
- **WanDancerVideo** — `WanDancerVideo` · 输入: positive, negative, vae, width, height, length, clip_vision_output, clip_vision_output_ref, start_image, mask, audio_encoder_output · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/fun control (2)

- **Wan22FunControlToVideo** — `Wan22FunControlToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, ref_image, control_video · 输出: CONDITIONING, CONDITIONING, LATENT
- **WanFunControlToVideo** — `WanFunControlToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, clip_vision_output, start_image, control_video · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/fun inpaint (1)

- **WanFunInpaintToVideo** — `WanFunInpaintToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, clip_vision_output, start_image, end_image · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/humo (1)

- **WanHuMoImageToVideo** — `WanHuMoImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, audio_encoder_output, ref_image · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/infinite talk (1)

- **WanInfiniteTalkToVideo** — `WanInfiniteTalkToVideo` · 输入: mode, model, model_patch, positive, negative, vae, width, height, length, audio_encoder_output_1, motion_frame_count, audio_scale, clip_vision_output, start_image, previous_frames · 输出: MODEL, CONDITIONING, CONDITIONING, LATENT, INT

## model/conditioning/wan/move (6)

- **Generate Video Tracks** — `GenerateTracks` · 输入: width, height, start_x, start_y, end_x, end_y, num_frames, num_tracks, track_spread, bezier, mid_x, mid_y, interpolation, track_mask · 输出: TRACKS, INT
- **WanMoveConcatTrack** — `WanMoveConcatTrack` · 输入: tracks_1, tracks_2 · 输出: TRACKS
- **WanMoveTracksFromCoords** — `WanMoveTracksFromCoords` · 输入: track_coords, track_mask · 输出: TRACKS, INT
- **WanMoveTrackToVideo** — `WanMoveTrackToVideo` · 输入: positive, negative, vae, strength, width, height, length, batch_size, start_image, tracks, clip_vision_output · 输出: CONDITIONING, CONDITIONING, LATENT
- **WanMoveVisualizeTracks** — `WanMoveVisualizeTracks` · 输入: images, line_resolution, circle_size, opacity, line_width, tracks · 输出: IMAGE
- **WanTrackToVideo** — `WanTrackToVideo` · 输入: positive, negative, vae, tracks, width, height, length, batch_size, temperature, topk, start_image, clip_vision_output · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/phantom subject (1)

- **WanPhantomSubjectToVideo** — `WanPhantomSubjectToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, images · 输出: CONDITIONING, CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/scail (2)

- **Create SCAIL-2 Colored Mask** — `SCAIL2ColoredMask` · 输入: driving_track_data, object_indices, sort_by, replacement_mode, ref_track_data · 输出: IMAGE, IMAGE
- **WanSCAILToVideo** — `WanSCAILToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, pose_strength, pose_start, pose_end, video_frame_offset, previous_frame_count, pose_video, pose_video_mask, replacement_mode, reference_image, reference_image_mask, clip_vision_output, previous_frames · 输出: CONDITIONING, CONDITIONING, LATENT, INT

## model/conditioning/wan/sound (2)

- **WanSoundImageToVideo** — `WanSoundImageToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, audio_encoder_output, ref_image, control_video, ref_motion · 输出: CONDITIONING, CONDITIONING, LATENT
- **WanSoundImageToVideoExtend** — `WanSoundImageToVideoExtend` · 输入: positive, negative, vae, length, video_latent, audio_encoder_output, ref_image, control_video · 输出: CONDITIONING, CONDITIONING, LATENT

## model/conditioning/wan/vace (1)

- **WanVaceToVideo** — `WanVaceToVideo` · 输入: positive, negative, vae, width, height, length, batch_size, strength, control_video, control_masks, reference_image · 输出: CONDITIONING, CONDITIONING, LATENT, INT

## model/conditioning/z-image (1)

- **TextEncodeZImageOmni** — `TextEncodeZImageOmni` · 输入: clip, prompt, auto_resize_images, image_encoder, vae, image1, image2, image3 · 输出: CONDITIONING

## model/latent (18)

- **Empty Latent Audio** — `EmptyLatentAudio` · 输入: seconds, batch_size · 输出: LATENT
- **Empty Latent Image** — `EmptyLatentImage` · 输入: width, height, batch_size · 输出: LATENT
- **Latent Composite** — `LatentComposite` · 输入: samples_to, samples_from, x, y, feather · 输出: LATENT
- **Latent Composite Masked** — `LatentCompositeMasked` · 输入: destination, source, x, y, resize_source, mask · 输出: LATENT
- **Load Latent** — `LoadLatent` · 输入: latent · 输出: LATENT
- **Save Latent** — `SaveLatent` · 输入: samples, filename_prefix · 输出: LATENT
- **Set Latent Noise Mask** — `SetLatentNoiseMask` · 输入: samples, mask · 输出: LATENT
- **Trim Video Latent** — `TrimVideoLatent` · 输入: samples, trim_amount · 输出: LATENT
- **Upscale Latent** — `LatentUpscale` · 输入: samples, upscale_method, width, height, crop · 输出: LATENT
- **Upscale Latent By** — `LatentUpscaleBy` · 输入: samples, upscale_method, scale_by · 输出: LATENT
- **VAE Decode** — `VAEDecode` · 输入: samples, vae · 输出: IMAGE
- **VAE Decode (Tiled)** — `VAEDecodeTiled` · 输入: samples, vae, tile_size, overlap, temporal_size, temporal_overlap · 输出: IMAGE
- **VAE Decode Audio** — `VAEDecodeAudio` · 输入: samples, vae · 输出: AUDIO
- **VAE Decode Audio (Tiled)** — `VAEDecodeAudioTiled` · 输入: samples, vae, tile_size, overlap · 输出: AUDIO
- **VAE Encode** — `VAEEncode` · 输入: pixels, vae · 输出: LATENT
- **VAE Encode (for Inpainting)** — `VAEEncodeForInpaint` · 输入: pixels, vae, mask, grow_mask_by · 输出: LATENT
- **VAE Encode (Tiled)** — `VAEEncodeTiled` · 输入: pixels, vae, tile_size, overlap, temporal_size, temporal_overlap · 输出: LATENT
- **VAE Encode Audio** — `VAEEncodeAudio` · 输入: audio, vae · 输出: LATENT

## model/latent/ace (2)

- **Empty Ace Step 1.0 Latent Audio** — `EmptyAceStepLatentAudio` · 输入: seconds, batch_size · 输出: LATENT
- **Empty Ace Step 1.5 Latent Audio** — `EmptyAceStep1.5LatentAudio` · 输入: seconds, batch_size · 输出: LATENT

## model/latent/advanced (8)

- **LatentAdd** — `LatentAdd` · 输入: samples1, samples2 · 输出: LATENT
- **LatentBatchSeedBehavior** — `LatentBatchSeedBehavior` · 输入: samples, seed_behavior · 输出: LATENT
- **LatentConcat** — `LatentConcat` · 输入: samples1, samples2, dim · 输出: LATENT
- **LatentCut** — `LatentCut` · 输入: samples, dim, index, amount · 输出: LATENT
- **LatentCutToBatch** — `LatentCutToBatch` · 输入: samples, dim, slice_size · 输出: LATENT
- **LatentInterpolate** — `LatentInterpolate` · 输入: samples1, samples2, ratio · 输出: LATENT
- **LatentMultiply** — `LatentMultiply` · 输入: samples, multiplier · 输出: LATENT
- **LatentSubtract** — `LatentSubtract` · 输入: samples1, samples2 · 输出: LATENT

## model/latent/advanced/operations (4)

- **LatentApplyOperation** — `LatentApplyOperation` · 输入: samples, operation · 输出: LATENT
- **LatentApplyOperationCFG** — `LatentApplyOperationCFG` · 输入: model, operation · 输出: MODEL
- **LatentOperationSharpen** — `LatentOperationSharpen` · 输入: sharpen_radius, sigma, alpha · 输出: LATENT_OPERATION
- **LatentOperationTonemapReinhard** — `LatentOperationTonemapReinhard` · 输入: multiplier · 输出: LATENT_OPERATION

## model/latent/autoregressive (1)

- **EmptyARVideoLatent** — `EmptyARVideoLatent` · 输入: width, height, length, batch_size · 输出: LATENT

## model/latent/batch (8)

- **Batch Latents** — `BatchLatentsNode` · 输入: latents · 输出: LATENT
- **Batch Latents (DEPRECATED)** — `LatentBatch` · 输入: samples1, samples2 · 输出: LATENT
- **Get Latent From Batch** — `LatentFromBatch` · 输入: samples, batch_index, length · 输出: LATENT
- **Merge SeedVR2 Latents** — `SeedVR2TemporalMerge` · 输入: latents, temporal_overlap · 输出: LATENT
- **Rebatch Latents** — `RebatchLatents` · 输入: latents, batch_size · 输出: LATENT
- **Repeat Latent Batch** — `RepeatLatentBatch` · 输入: samples, amount · 输出: LATENT
- **Replace Video Latent Frames** — `ReplaceVideoLatentFrames` · 输入: destination, index, source · 输出: LATENT
- **Split SeedVR2 Latent** — `SeedVR2TemporalChunk` · 输入: latent, temporal_overlap, chunking_mode · 输出: LATENT, INT

## model/latent/chroma radiance (1)

- **EmptyChromaRadianceLatentImage** — `EmptyChromaRadianceLatentImage` · 输入: width, height, batch_size · 输出: LATENT

## model/latent/cosmos (1)

- **EmptyCosmosLatentVideo** — `EmptyCosmosLatentVideo` · 输入: width, height, length, batch_size · 输出: LATENT

## model/latent/flux (1)

- **Empty Flux 2 Latent** — `EmptyFlux2LatentImage` · 输入: width, height, batch_size · 输出: LATENT

## model/latent/hidream (1)

- **Empty HiDream-O1 Latent Image** — `EmptyHiDreamO1LatentImage` · 输入: width, height, batch_size · 输出: LATENT

## model/latent/hunyhuan video (1)

- **Hunyuan Video 15 Latent Upscale With Model** — `HunyuanVideo15LatentUpscaleWithModel` · 输入: model, samples, upscale_method, width, height, crop · 输出: LATENT

## model/latent/hunyuan 3d (2)

- **EmptyLatentHunyuan3Dv2** — `EmptyLatentHunyuan3Dv2` · 输入: resolution, batch_size · 输出: LATENT
- **VAEDecodeHunyuan3D** — `VAEDecodeHunyuan3D` · 输入: samples, vae, num_chunks, octree_resolution · 输出: VOXEL

## model/latent/hunyuan image (1)

- **EmptyHunyuanImageLatent** — `EmptyHunyuanImageLatent` · 输入: width, height, batch_size · 输出: LATENT

## model/latent/hunyuan video (2)

- **Empty HunyuanVideo 1.0 Latent** — `EmptyHunyuanLatentVideo` · 输入: width, height, length, batch_size · 输出: LATENT
- **Empty HunyuanVideo 1.5 Latent** — `EmptyHunyuanVideo15Latent` · 输入: width, height, length, batch_size · 输出: LATENT

## model/latent/ltxv (7)

- **Concat AV Latent** — `LTXVConcatAVLatent` · 输入: video_latent, audio_latent · 输出: LATENT
- **EmptyLTXVLatentVideo** — `EmptyLTXVLatentVideo` · 输入: width, height, length, batch_size · 输出: LATENT
- **LTXV Audio VAE Decode** — `LTXVAudioVAEDecode` · 输入: samples, audio_vae · 输出: AUDIO
- **LTXV Audio VAE Encode** — `LTXVAudioVAEEncode` · 输入: audio, audio_vae · 输出: LATENT
- **LTXV Empty Latent Audio** — `LTXVEmptyLatentAudio` · 输入: frames_number, frame_rate, batch_size, audio_vae · 输出: LATENT
- **LTXVLatentUpsampler** — `LTXVLatentUpsampler` · 输入: samples, upscale_model, vae · 输出: LATENT
- **Separate AV Latent** — `LTXVSeparateAVLatent` · 输入: av_latent · 输出: LATENT, LATENT

## model/latent/minimax (1)

- **Empty MiniMax H3 AV Latent** — `EmptyMiniMaxH3LatentAV` · 输入: width, height, length · 输出: LATENT

## model/latent/minimax music (1)

- **Empty MiniMax Music3 Latent Audio** — `EmptyMiniMaxMusic3LatentAudio` · 输入: seconds, batch_size · 输出: LATENT

## model/latent/mochi (1)

- **EmptyMochiLatentVideo** — `EmptyMochiLatentVideo` · 输入: width, height, length, batch_size · 输出: LATENT

## model/latent/qwen (1)

- **Empty Qwen Image Layered Latent** — `EmptyQwenImageLayeredLatentImage` · 输入: width, height, layers, batch_size · 输出: LATENT

## model/latent/stable cascade (2)

- **StableCascade_EmptyLatentImage** — `StableCascade_EmptyLatentImage` · 输入: width, height, compression, batch_size · 输出: LATENT, LATENT
- **StableCascade_StageC_VAEEncode** — `StableCascade_StageC_VAEEncode` · 输入: image, vae, compression · 输出: LATENT, LATENT

## model/latent/stable diffusion (1)

- **EmptySD3LatentImage** — `EmptySD3LatentImage` · 输入: width, height, batch_size · 输出: LATENT

## model/latent/transform (3)

- **Crop Latent** — `LatentCrop` · 输入: samples, width, height, x, y · 输出: LATENT
- **Flip Latent** — `LatentFlip` · 输入: samples, flip_method · 输出: LATENT
- **Rotate Latent** — `LatentRotate` · 输入: samples, rotation · 输出: LATENT

## model/latent/trellis (4)

- **EmptyTrellis2LatentStructure** — `EmptyTrellis2LatentStructure` · 输入: batch_size · 输出: LATENT
- **VaeDecodeShapeTrellis** — `VaeDecodeShapeTrellis` · 输入: samples, vae · 输出: MESH, SHAPE_SUBDIVIDES
- **VaeDecodeStructureTrellis2** — `VaeDecodeStructureTrellis2` · 输入: samples, vae, resolution · 输出: VOXEL
- **VaeDecodeTextureTrellis** — `VaeDecodeTextureTrellis` · 输入: samples, vae, shape_subdivides · 输出: VOXEL

## model/latent/triposplat (2)

- **TripoSplat Decode** — `VAEDecodeTripoSplat` · 输入: samples, vae, num_gaussians, seed · 输出: SPLAT
- **TripoSplat Sampling Preview** — `TripoSplatSamplingPreview` · 输入: model, vae, octree_level, num_gaussians, yaw, pitch, point_size · 输出: MODEL

## model/latent/void (2)

- **VOIDWarpedNoise** — `VOIDWarpedNoise` · 输入: optical_flow, video, width, height, length, batch_size · 输出: LATENT
- **VOIDWarpedNoiseSource** — `VOIDWarpedNoiseSource` · 输入: warped_noise · 输出: NOISE

## model/loaders (35)

- **Load Audio Encoder** — `AudioEncoderLoader` · 输入: audio_encoder_name · 输出: AUDIO_ENCODER
- **Load Background Removal Model** — `LoadBackgroundRemovalModel` · 输入: bg_removal_name · 输出: BACKGROUND_REMOVAL
- **Load Checkpoint** — `CheckpointLoaderSimple` · 输入: ckpt_name · 输出: MODEL, CLIP, VAE
- **Load Checkpoint Image Only (img2vid model)** — `ImageOnlyCheckpointLoader` · 输入: ckpt_name · 输出: MODEL, CLIP_VISION, VAE
- **Load Checkpoint With Config (DEPRECATED)** — `CheckpointLoader` · 输入: config_name, ckpt_name · 输出: MODEL, CLIP, VAE
- **Load CLIP** — `CLIPLoader` · 输入: clip_name, type, device · 输出: CLIP
- **Load CLIP (Dual)** — `DualCLIPLoader` · 输入: clip_name1, clip_name2, type, device · 输出: CLIP
- **Load CLIP (Quadruple)** — `QuadrupleCLIPLoader` · 输入: clip_name1, clip_name2, clip_name3, clip_name4 · 输出: CLIP
- **Load CLIP (Triple)** — `TripleCLIPLoader` · 输入: clip_name1, clip_name2, clip_name3 · 输出: CLIP
- **Load CLIP Vision** — `CLIPVisionLoader` · 输入: clip_name · 输出: CLIP_VISION
- **Load ControlNet Model** — `ControlNetLoader` · 输入: control_net_name · 输出: CONTROL_NET
- **Load ControlNet Model (diff)** — `DiffControlNetLoader` · 输入: model, control_net_name · 输出: CONTROL_NET
- **Load Depth Anything 3** — `LoadDA3Model` · 输入: model_name, weight_dtype · 输出: DA3_MODEL
- **Load Diffusers Model (DEPRECATED)** — `DiffusersLoader` · 输入: model_path · 输出: MODEL, CLIP, VAE
- **Load Diffusion Model** — `UNETLoader` · 输入: unet_name, weight_dtype · 输出: MODEL
- **Load Face Detection Model (MediaPipe)** — `LoadMediaPipeFaceLandmarker` · 输入: model_name · 输出: FACE_DETECTION_MODEL
- **Load Frame Interpolation Model** — `FrameInterpolationModelLoader` · 输入: model_name · 输出: INTERP_MODEL
- **Load GLIGEN Model** — `GLIGENLoader` · 输入: gligen_name · 输出: GLIGEN
- **Load Hypernetwork** — `HypernetworkLoader` · 输入: model, hypernetwork_name, strength · 输出: MODEL
- **Load Latent Upscale Model** — `LatentUpscaleModelLoader` · 输入: model_name · 输出: LATENT_UPSCALE_MODEL
- **Load LoRA** — `LoraLoaderModelOnly` · 输入: model, lora_name, strength_model · 输出: MODEL
- **Load LoRA (Bypass, Model Only) (for debugging)** — `LoraLoaderBypassModelOnly` · 输入: model, lora_name, strength_model · 输出: MODEL
- **Load LoRA (Bypass) (For debugging)** — `LoraLoaderBypass` · 输入: model, clip, lora_name, strength_model, strength_clip · 输出: MODEL, CLIP
- **Load LoRA (Model and CLIP)** — `LoraLoader` · 输入: model, clip, lora_name, strength_model, strength_clip · 输出: MODEL, CLIP
- **Load LoRA Model** — `LoraModelLoader` · 输入: model, lora, strength_model, bypass · 输出: MODEL
- **Load LTXV Audio Text Encoder** — `LTXAVTextEncoderLoader` · 输入: text_encoder, ckpt_name, device · 输出: CLIP
- **Load LTXV Audio VAE** — `LTXVAudioVAELoader` · 输入: ckpt_name · 输出: VAE
- **Load Model Patch** — `ModelPatchLoader` · 输入: name · 输出: MODEL_PATCH
- **Load MoGe Model** — `LoadMoGeModel` · 输入: model_name · 输出: MOGE_MODEL
- **Load Optical Flow Model** — `OpticalFlowLoader` · 输入: model_name · 输出: OPTICAL_FLOW
- **Load PhotoMaker Model** — `PhotoMakerLoader` · 输入: photomaker_model_name · 输出: PHOTOMAKER
- **Load Style Model** — `StyleModelLoader` · 输入: style_model_name · 输出: STYLE_MODEL
- **Load unCLIP Checkpoint** — `unCLIPCheckpointLoader` · 输入: ckpt_name · 输出: MODEL, CLIP, VAE, CLIP_VISION
- **Load Upscale Model** — `UpscaleModelLoader` · 输入: model_name · 输出: UPSCALE_MODEL
- **Load VAE** — `VAELoader` · 输入: vae_name · 输出: VAE

## model/merging (13)

- **CLIPMergeAdd** — `CLIPMergeAdd` · 输入: clip1, clip2 · 输出: CLIP
- **CLIPMergeSimple** — `CLIPMergeSimple` · 输入: clip1, clip2, ratio · 输出: CLIP
- **CLIPMergeSubtract** — `CLIPMergeSubtract` · 输入: clip1, clip2, multiplier · 输出: CLIP
- **CLIPSave** — `CLIPSave` · 输入: clip, filename_prefix · 输出: 无
- **ImageOnlyCheckpointSave** — `ImageOnlyCheckpointSave` · 输入: model, clip_vision, vae, filename_prefix · 输出: 无
- **ModelMergeAdd** — `ModelMergeAdd` · 输入: model1, model2 · 输出: MODEL
- **ModelMergeBlocks** — `ModelMergeBlocks` · 输入: model1, model2, input, middle, out · 输出: MODEL
- **ModelMergeSimple** — `ModelMergeSimple` · 输入: model1, model2, ratio · 输出: MODEL
- **ModelMergeSubtract** — `ModelMergeSubtract` · 输入: model1, model2, multiplier · 输出: MODEL
- **ModelSave** — `ModelSave` · 输入: model, filename_prefix · 输出: 无
- **Save Checkpoint** — `CheckpointSave` · 输入: model, clip, vae, filename_prefix · 输出: 无
- **Save LoRA Weights** — `SaveLoRA` · 输入: lora, prefix, steps · 输出: 无
- **VAESave** — `VAESave` · 输入: vae, filename_prefix · 输出: 无

## model/merging/model specific (16)

- **ModelMergeAuraflow** — `ModelMergeAuraflow` · 输入: model1, model2, init_x_linear., positional_encoding, cond_seq_linear., register_tokens, t_embedder., double_layers.0., double_layers.1., double_layers.2., double_layers.3., single_layers.0., single_layers.1., single_layers.2., single_layers.3., single_layers.4., single_layers.5., single_layers.6., single_layers.7., single_layers.8., single_layers.9., single_layers.10., single_layers.11., single_layers.12., single_layers.13., single_layers.14., single_layers.15., single_layers.16., single_layers.17., single_layers.18., single_layers.19., single_layers.20., single_layers.21., single_layers.22., single_layers.23., single_layers.24., single_layers.25., single_layers.26., single_layers.27., single_layers.28., single_layers.29., single_layers.30., single_layers.31., modF., final_linear. · 输出: MODEL
- **ModelMergeCosmos14B** — `ModelMergeCosmos14B` · 输入: model1, model2, pos_embedder., extra_pos_embedder., x_embedder., t_embedder., affline_norm., blocks.block0., blocks.block1., blocks.block2., blocks.block3., blocks.block4., blocks.block5., blocks.block6., blocks.block7., blocks.block8., blocks.block9., blocks.block10., blocks.block11., blocks.block12., blocks.block13., blocks.block14., blocks.block15., blocks.block16., blocks.block17., blocks.block18., blocks.block19., blocks.block20., blocks.block21., blocks.block22., blocks.block23., blocks.block24., blocks.block25., blocks.block26., blocks.block27., blocks.block28., blocks.block29., blocks.block30., blocks.block31., blocks.block32., blocks.block33., blocks.block34., blocks.block35., final_layer. · 输出: MODEL
- **ModelMergeCosmos7B** — `ModelMergeCosmos7B` · 输入: model1, model2, pos_embedder., extra_pos_embedder., x_embedder., t_embedder., affline_norm., blocks.block0., blocks.block1., blocks.block2., blocks.block3., blocks.block4., blocks.block5., blocks.block6., blocks.block7., blocks.block8., blocks.block9., blocks.block10., blocks.block11., blocks.block12., blocks.block13., blocks.block14., blocks.block15., blocks.block16., blocks.block17., blocks.block18., blocks.block19., blocks.block20., blocks.block21., blocks.block22., blocks.block23., blocks.block24., blocks.block25., blocks.block26., blocks.block27., final_layer. · 输出: MODEL
- **ModelMergeCosmosPredict2_14B** — `ModelMergeCosmosPredict2_14B` · 输入: model1, model2, pos_embedder., x_embedder., t_embedder., t_embedding_norm., blocks.0., blocks.1., blocks.2., blocks.3., blocks.4., blocks.5., blocks.6., blocks.7., blocks.8., blocks.9., blocks.10., blocks.11., blocks.12., blocks.13., blocks.14., blocks.15., blocks.16., blocks.17., blocks.18., blocks.19., blocks.20., blocks.21., blocks.22., blocks.23., blocks.24., blocks.25., blocks.26., blocks.27., blocks.28., blocks.29., blocks.30., blocks.31., blocks.32., blocks.33., blocks.34., blocks.35., final_layer. · 输出: MODEL
- **ModelMergeCosmosPredict2_2B** — `ModelMergeCosmosPredict2_2B` · 输入: model1, model2, pos_embedder., x_embedder., t_embedder., t_embedding_norm., blocks.0., blocks.1., blocks.2., blocks.3., blocks.4., blocks.5., blocks.6., blocks.7., blocks.8., blocks.9., blocks.10., blocks.11., blocks.12., blocks.13., blocks.14., blocks.15., blocks.16., blocks.17., blocks.18., blocks.19., blocks.20., blocks.21., blocks.22., blocks.23., blocks.24., blocks.25., blocks.26., blocks.27., final_layer. · 输出: MODEL
- **ModelMergeFlux1** — `ModelMergeFlux1` · 输入: model1, model2, img_in., time_in., guidance_in, vector_in., txt_in., double_blocks.0., double_blocks.1., double_blocks.2., double_blocks.3., double_blocks.4., double_blocks.5., double_blocks.6., double_blocks.7., double_blocks.8., double_blocks.9., double_blocks.10., double_blocks.11., double_blocks.12., double_blocks.13., double_blocks.14., double_blocks.15., double_blocks.16., double_blocks.17., double_blocks.18., single_blocks.0., single_blocks.1., single_blocks.2., single_blocks.3., single_blocks.4., single_blocks.5., single_blocks.6., single_blocks.7., single_blocks.8., single_blocks.9., single_blocks.10., single_blocks.11., single_blocks.12., single_blocks.13., single_blocks.14., single_blocks.15., single_blocks.16., single_blocks.17., single_blocks.18., single_blocks.19., single_blocks.20., single_blocks.21., single_blocks.22., single_blocks.23., single_blocks.24., single_blocks.25., single_blocks.26., single_blocks.27., single_blocks.28., single_blocks.29., single_blocks.30., single_blocks.31., single_blocks.32., single_blocks.33., single_blocks.34., single_blocks.35., single_blocks.36., single_blocks.37., final_layer. · 输出: MODEL
- **ModelMergeKrea2** — `ModelMergeKrea2` · 输入: model1, model2, first., tmlp., txtmlp., tproj., txtfusion.layerwise_blocks.0., txtfusion.layerwise_blocks.1., txtfusion.projector., txtfusion.refiner_blocks.0., txtfusion.refiner_blocks.1., blocks.0., blocks.1., blocks.2., blocks.3., blocks.4., blocks.5., blocks.6., blocks.7., blocks.8., blocks.9., blocks.10., blocks.11., blocks.12., blocks.13., blocks.14., blocks.15., blocks.16., blocks.17., blocks.18., blocks.19., blocks.20., blocks.21., blocks.22., blocks.23., blocks.24., blocks.25., blocks.26., blocks.27., last. · 输出: MODEL
- **ModelMergeLTXV** — `ModelMergeLTXV` · 输入: model1, model2, patchify_proj., adaln_single., caption_projection., transformer_blocks.0., transformer_blocks.1., transformer_blocks.2., transformer_blocks.3., transformer_blocks.4., transformer_blocks.5., transformer_blocks.6., transformer_blocks.7., transformer_blocks.8., transformer_blocks.9., transformer_blocks.10., transformer_blocks.11., transformer_blocks.12., transformer_blocks.13., transformer_blocks.14., transformer_blocks.15., transformer_blocks.16., transformer_blocks.17., transformer_blocks.18., transformer_blocks.19., transformer_blocks.20., transformer_blocks.21., transformer_blocks.22., transformer_blocks.23., transformer_blocks.24., transformer_blocks.25., transformer_blocks.26., transformer_blocks.27., scale_shift_table, proj_out. · 输出: MODEL
- **ModelMergeMochiPreview** — `ModelMergeMochiPreview` · 输入: model1, model2, pos_frequencies., t_embedder., t5_y_embedder., t5_yproj., blocks.0., blocks.1., blocks.2., blocks.3., blocks.4., blocks.5., blocks.6., blocks.7., blocks.8., blocks.9., blocks.10., blocks.11., blocks.12., blocks.13., blocks.14., blocks.15., blocks.16., blocks.17., blocks.18., blocks.19., blocks.20., blocks.21., blocks.22., blocks.23., blocks.24., blocks.25., blocks.26., blocks.27., blocks.28., blocks.29., blocks.30., blocks.31., blocks.32., blocks.33., blocks.34., blocks.35., blocks.36., blocks.37., blocks.38., blocks.39., blocks.40., blocks.41., blocks.42., blocks.43., blocks.44., blocks.45., blocks.46., blocks.47., final_layer. · 输出: MODEL
- **ModelMergeQwenImage** — `ModelMergeQwenImage` · 输入: model1, model2, pos_embeds., img_in., txt_norm., txt_in., time_text_embed., transformer_blocks.0., transformer_blocks.1., transformer_blocks.2., transformer_blocks.3., transformer_blocks.4., transformer_blocks.5., transformer_blocks.6., transformer_blocks.7., transformer_blocks.8., transformer_blocks.9., transformer_blocks.10., transformer_blocks.11., transformer_blocks.12., transformer_blocks.13., transformer_blocks.14., transformer_blocks.15., transformer_blocks.16., transformer_blocks.17., transformer_blocks.18., transformer_blocks.19., transformer_blocks.20., transformer_blocks.21., transformer_blocks.22., transformer_blocks.23., transformer_blocks.24., transformer_blocks.25., transformer_blocks.26., transformer_blocks.27., transformer_blocks.28., transformer_blocks.29., transformer_blocks.30., transformer_blocks.31., transformer_blocks.32., transformer_blocks.33., transformer_blocks.34., transformer_blocks.35., transformer_blocks.36., transformer_blocks.37., transformer_blocks.38., transformer_blocks.39., transformer_blocks.40., transformer_blocks.41., transformer_blocks.42., transformer_blocks.43., transformer_blocks.44., transformer_blocks.45., transformer_blocks.46., transformer_blocks.47., transformer_blocks.48., transformer_blocks.49., transformer_blocks.50., transformer_blocks.51., transformer_blocks.52., transformer_blocks.53., transformer_blocks.54., transformer_blocks.55., transformer_blocks.56., transformer_blocks.57., transformer_blocks.58., transformer_blocks.59., proj_out. · 输出: MODEL
- **ModelMergeSD1** — `ModelMergeSD1` · 输入: model1, model2, time_embed., label_emb., input_blocks.0., input_blocks.1., input_blocks.2., input_blocks.3., input_blocks.4., input_blocks.5., input_blocks.6., input_blocks.7., input_blocks.8., input_blocks.9., input_blocks.10., input_blocks.11., middle_block.0., middle_block.1., middle_block.2., output_blocks.0., output_blocks.1., output_blocks.2., output_blocks.3., output_blocks.4., output_blocks.5., output_blocks.6., output_blocks.7., output_blocks.8., output_blocks.9., output_blocks.10., output_blocks.11., out. · 输出: MODEL
- **ModelMergeSD2** — `ModelMergeSD2` · 输入: model1, model2, time_embed., label_emb., input_blocks.0., input_blocks.1., input_blocks.2., input_blocks.3., input_blocks.4., input_blocks.5., input_blocks.6., input_blocks.7., input_blocks.8., input_blocks.9., input_blocks.10., input_blocks.11., middle_block.0., middle_block.1., middle_block.2., output_blocks.0., output_blocks.1., output_blocks.2., output_blocks.3., output_blocks.4., output_blocks.5., output_blocks.6., output_blocks.7., output_blocks.8., output_blocks.9., output_blocks.10., output_blocks.11., out. · 输出: MODEL
- **ModelMergeSD3_2B** — `ModelMergeSD3_2B` · 输入: model1, model2, pos_embed., x_embedder., context_embedder., y_embedder., t_embedder., joint_blocks.0., joint_blocks.1., joint_blocks.2., joint_blocks.3., joint_blocks.4., joint_blocks.5., joint_blocks.6., joint_blocks.7., joint_blocks.8., joint_blocks.9., joint_blocks.10., joint_blocks.11., joint_blocks.12., joint_blocks.13., joint_blocks.14., joint_blocks.15., joint_blocks.16., joint_blocks.17., joint_blocks.18., joint_blocks.19., joint_blocks.20., joint_blocks.21., joint_blocks.22., joint_blocks.23., final_layer. · 输出: MODEL
- **ModelMergeSD35_Large** — `ModelMergeSD35_Large` · 输入: model1, model2, pos_embed., x_embedder., context_embedder., y_embedder., t_embedder., joint_blocks.0., joint_blocks.1., joint_blocks.2., joint_blocks.3., joint_blocks.4., joint_blocks.5., joint_blocks.6., joint_blocks.7., joint_blocks.8., joint_blocks.9., joint_blocks.10., joint_blocks.11., joint_blocks.12., joint_blocks.13., joint_blocks.14., joint_blocks.15., joint_blocks.16., joint_blocks.17., joint_blocks.18., joint_blocks.19., joint_blocks.20., joint_blocks.21., joint_blocks.22., joint_blocks.23., joint_blocks.24., joint_blocks.25., joint_blocks.26., joint_blocks.27., joint_blocks.28., joint_blocks.29., joint_blocks.30., joint_blocks.31., joint_blocks.32., joint_blocks.33., joint_blocks.34., joint_blocks.35., joint_blocks.36., joint_blocks.37., final_layer. · 输出: MODEL
- **ModelMergeSDXL** — `ModelMergeSDXL` · 输入: model1, model2, time_embed., label_emb., input_blocks.0, input_blocks.1, input_blocks.2, input_blocks.3, input_blocks.4, input_blocks.5, input_blocks.6, input_blocks.7, input_blocks.8, middle_block.0, middle_block.1, middle_block.2, output_blocks.0, output_blocks.1, output_blocks.2, output_blocks.3, output_blocks.4, output_blocks.5, output_blocks.6, output_blocks.7, output_blocks.8, out. · 输出: MODEL
- **ModelMergeWAN2_1** — `ModelMergeWAN2_1` · 输入: model1, model2, patch_embedding., time_embedding., time_projection., text_embedding., img_emb., blocks.0., blocks.1., blocks.2., blocks.3., blocks.4., blocks.5., blocks.6., blocks.7., blocks.8., blocks.9., blocks.10., blocks.11., blocks.12., blocks.13., blocks.14., blocks.15., blocks.16., blocks.17., blocks.18., blocks.19., blocks.20., blocks.21., blocks.22., blocks.23., blocks.24., blocks.25., blocks.26., blocks.27., blocks.28., blocks.29., blocks.30., blocks.31., blocks.32., blocks.33., blocks.34., blocks.35., blocks.36., blocks.37., blocks.38., blocks.39., head. · 输出: MODEL

## model/patch (11)

- **Context Windows (Manual)** — `ContextWindowsManual` · 输入: model, context_length, context_overlap, context_schedule, context_stride, closed_loop, fuse_method, dim, freenoise, cond_retain_index_list, split_conds_to_windows, latent_retain_index_list, causal_window_fix · 输出: MODEL
- **LTXV Context Windows** — `LTXVContextWindows` · 输入: model, context_length, context_overlap, context_schedule, context_stride, closed_loop, fuse_method, freenoise, retain_first_frame, split_conds_to_windows · 输出: MODEL
- **ModelAttentionBackend** — `ModelAttentionBackend` · 输入: model, attention · 输出: MODEL
- **ModelNoiseScale** — `ModelNoiseScale` · 输入: model, noise_scale · 输出: MODEL
- **ModelSamplingAuraFlow** — `ModelSamplingAuraFlow` · 输入: model, shift · 输出: MODEL
- **ModelSamplingContinuousEDM** — `ModelSamplingContinuousEDM` · 输入: model, sampling, sigma_max, sigma_min · 输出: MODEL
- **ModelSamplingContinuousV** — `ModelSamplingContinuousV` · 输入: model, sampling, sigma_max, sigma_min · 输出: MODEL
- **ModelSamplingDiscrete** — `ModelSamplingDiscrete` · 输入: model, sampling, zsnr · 输出: MODEL
- **RenormCFG** — `RenormCFG` · 输入: model, cfg_trunc, renorm_cfg · 输出: MODEL
- **RescaleCFG** — `RescaleCFG` · 输入: model, multiplier · 输出: MODEL
- **ScaleROPE** — `ScaleROPE` · 输入: model, scale_x, shift_x, scale_y, shift_y, scale_t, shift_t · 输出: MODEL

## model/patch/chroma radiance (1)

- **ChromaRadianceOptions** — `ChromaRadianceOptions` · 输入: model, preserve_wrapper, start_sigma, end_sigma, nerf_tile_size, force_sequential_txt_ids · 输出: MODEL

## model/patch/flux (2)

- **Apply USO Style Reference** — `USOStyleReference` · 输入: model, model_patch, clip_vision_output · 输出: MODEL
- **ModelSamplingFlux** — `ModelSamplingFlux` · 输入: model, max_shift, base_shift, width, height · 输出: MODEL

## model/patch/hidream (1)

- **HiDream-O1 Patch Seam Smoothing** — `HiDreamO1PatchSeamSmoothing` · 输入: model, start_percent, end_percent, pattern, passes, blend, strength · 输出: MODEL

## model/patch/ltxv (1)

- **ModelSamplingLTXV** — `ModelSamplingLTXV` · 输入: model, max_shift, base_shift, latent · 输出: MODEL

## model/patch/minimax (1)

- **ModelSamplingMiniMaxH3** — `MiniMaxH3SigmaShift` · 输入: model, shift_video, shift_audio · 输出: MODEL

## model/patch/qwen (1)

- **Apply Qwen Image DiffSynth ControlNet** — `QwenImageDiffsynthControlnet` · 输入: model, model_patch, vae, image, strength, mask · 输出: MODEL

## model/patch/stable cascade (1)

- **ModelSamplingStableCascade** — `ModelSamplingStableCascade` · 输入: model, shift · 输出: MODEL

## model/patch/stable diffusion (1)

- **ModelSamplingSD3** — `ModelSamplingSD3` · 输入: model, shift · 输出: MODEL

## model/patch/supir (1)

- **SUPIRApply** — `SUPIRApply` · 输入: model, model_patch, vae, image, strength_start, strength_end, restore_cfg, restore_cfg_s_tmin · 输出: MODEL

## model/patch/unet (8)

- **Epsilon Scaling** — `Epsilon Scaling` · 输入: model, scaling_factor · 输出: MODEL
- **FreeU** — `FreeU` · 输入: model, b1, b2, s1, s2 · 输出: MODEL
- **FreeU_V2** — `FreeU_V2` · 输入: model, b1, b2, s1, s2 · 输出: MODEL
- **HyperTile** — `HyperTile` · 输入: model, tile_size, swap_size, max_depth, scale_depth · 输出: MODEL
- **PatchModelAddDownscale (Kohya Deep Shrink)** — `PatchModelAddDownscale` · 输入: model, block_number, downscale_factor, start_percent, end_percent, downscale_after_skip, downscale_method, upscale_method · 输出: MODEL
- **PerturbedAttentionGuidance** — `PerturbedAttentionGuidance` · 输入: model, scale · 输出: MODEL
- **TomePatchModel** — `TomePatchModel` · 输入: model, ratio · 输出: MODEL
- **TSR - Temporal Score Rescaling** — `TemporalScoreRescaling` · 输入: model, tsr_k, tsr_sigma · 输出: MODEL

## model/patch/wan (2)

- **Apply Wan Uni3C ControlNet** — `WanUni3CControlnetApply` · 输入: model, model_patch, vae, render_video, strength, start_percent, end_percent · 输出: MODEL
- **Wan Context Windows** — `WanContextWindowsManual` · 输入: model, context_length, context_overlap, context_schedule, context_stride, closed_loop, fuse_method, freenoise, retain_first_frame, split_conds_to_windows · 输出: MODEL

## model/patch/z-image (1)

- **Apply Z-Image Fun ControlNet** — `ZImageFunControlnet` · 输入: model, model_patch, vae, strength, image, inpaint_image, mask · 输出: MODEL

## model/sampling (2)

- **KSampler** — `KSampler` · 输入: model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, denoise · 输出: LATENT
- **KSampler (Advanced)** — `KSamplerAdvanced` · 输入: model, add_noise, noise_seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, start_at_step, end_at_step, return_with_leftover_noise · 输出: LATENT

## model/sampling/custom (3)

- **Adaptive Projected Guidance** — `APG` · 输入: model, eta, norm_threshold, momentum · 输出: MODEL
- **SamplerCustom** — `SamplerCustom` · 输入: model, add_noise, noise_seed, cfg, positive, negative, sampler, sigmas, latent_image · 输出: LATENT, LATENT
- **SamplerCustomAdvanced** — `SamplerCustomAdvanced` · 输入: noise, guider, sampler, sigmas, latent_image · 输出: LATENT, LATENT

## model/sampling/guiders (8)

- **Basic Guider** — `BasicGuider` · 输入: model, conditioning · 输出: GUIDER
- **CFG Guider** — `CFGGuider` · 输入: model, positive, negative, cfg · 输出: GUIDER
- **CFG Override** — `CFGOverride` · 输入: model, cfg, start_percent, end_percent · 输出: MODEL
- **Dual CFG Guider** — `DualCFGGuider` · 输入: model, cond1, cond2, negative, cfg_conds, cfg_cond2_negative, style · 输出: GUIDER
- **Dual Model CFG Guider** — `DualModelGuider` · 输入: model, positive, cfg, model_negative, negative · 输出: GUIDER
- **LTXV Dual CFG Guider** — `LTXVDualCFGGuider` · 输入: model, positive, negative, video_cfg, audio_cfg · 输出: GUIDER
- **Video Linear CFG Guidance** — `VideoLinearCFGGuidance` · 输入: model, min_cfg · 输出: MODEL
- **Video Triangle CFG Guidance** — `VideoTriangleCFGGuidance` · 输入: model, min_cfg · 输出: MODEL

## model/sampling/noise (3)

- **AddNoise** — `AddNoise` · 输入: model, noise, sigmas, latent_image · 输出: LATENT
- **DisableNoise** — `DisableNoise` · 输入: 无 · 输出: NOISE
- **RandomNoise** — `RandomNoise` · 输入: noise_seed · 输出: NOISE

## model/sampling/samplers (16)

- **KSamplerSelect** — `KSamplerSelect` · 输入: sampler_name · 输出: SAMPLER
- **Sampler AR Video** — `SamplerARVideo` · 输入: num_frame_per_block · 输出: SAMPLER
- **SamplerDPMAdaptative** — `SamplerDPMAdaptative` · 输入: order, rtol, atol, h_init, pcoeff, icoeff, dcoeff, accept_safety, eta, s_noise · 输出: SAMPLER
- **SamplerDPMPP_2M_SDE** — `SamplerDPMPP_2M_SDE` · 输入: solver_type, eta, s_noise, noise_device · 输出: SAMPLER
- **SamplerDPMPP_2S_Ancestral** — `SamplerDPMPP_2S_Ancestral` · 输入: eta, s_noise · 输出: SAMPLER
- **SamplerDPMPP_3M_SDE** — `SamplerDPMPP_3M_SDE` · 输入: eta, s_noise, noise_device · 输出: SAMPLER
- **SamplerDPMPP_SDE** — `SamplerDPMPP_SDE` · 输入: eta, s_noise, r, noise_device · 输出: SAMPLER
- **SamplerER_SDE** — `SamplerER_SDE` · 输入: solver_type, max_stage, eta, s_noise · 输出: SAMPLER
- **SamplerEulerAncestral** — `SamplerEulerAncestral` · 输入: eta, s_noise · 输出: SAMPLER
- **SamplerEulerAncestralCFG++** — `SamplerEulerAncestralCFGPP` · 输入: eta, s_noise · 输出: SAMPLER
- **SamplerLCM** — `SamplerLCM` · 输入: s_noise, s_noise_end, noise_clip_std · 输出: SAMPLER
- **SamplerLCMUpscale** — `SamplerLCMUpscale` · 输入: scale_ratio, scale_steps, upscale_method · 输出: SAMPLER
- **SamplerLMS** — `SamplerLMS` · 输入: order · 输出: SAMPLER
- **SamplerSASolver** — `SamplerSASolver` · 输入: model, eta, sde_start_percent, sde_end_percent, s_noise, predictor_order, corrector_order, use_pece, simple_order_2 · 输出: SAMPLER
- **SamplerSEEDS2** — `SamplerSEEDS2` · 输入: solver_type, eta, s_noise, r · 输出: SAMPLER
- **VOIDSampler** — `VOIDSampler` · 输入: 无 · 输出: SAMPLER

## model/sampling/schedulers (14)

- **AlignYourStepsScheduler** — `AlignYourStepsScheduler` · 输入: model_type, steps, denoise · 输出: SIGMAS
- **BasicScheduler** — `BasicScheduler` · 输入: model, scheduler, steps, denoise · 输出: SIGMAS
- **BetaSamplingScheduler** — `BetaSamplingScheduler` · 输入: model, steps, alpha, beta · 输出: SIGMAS
- **ExponentialScheduler** — `ExponentialScheduler` · 输入: steps, sigma_max, sigma_min · 输出: SIGMAS
- **Flux2Scheduler** — `Flux2Scheduler` · 输入: steps, width, height · 输出: SIGMAS
- **GITSScheduler** — `GITSScheduler` · 输入: coeff, steps, denoise · 输出: SIGMAS
- **Ideogram 4 Scheduler** — `Ideogram4Scheduler` · 输入: steps, width, height, mu, std · 输出: SIGMAS
- **KarrasScheduler** — `KarrasScheduler` · 输入: steps, sigma_max, sigma_min, rho · 输出: SIGMAS
- **LaplaceScheduler** — `LaplaceScheduler` · 输入: steps, sigma_max, sigma_min, mu, beta · 输出: SIGMAS
- **LTXVScheduler** — `LTXVScheduler` · 输入: steps, max_shift, base_shift, stretch, terminal, latent · 输出: SIGMAS
- **OptimalStepsScheduler** — `OptimalStepsScheduler` · 输入: model_type, steps, denoise · 输出: SIGMAS
- **PolyexponentialScheduler** — `PolyexponentialScheduler` · 输入: steps, sigma_max, sigma_min, rho · 输出: SIGMAS
- **SDTurboScheduler** — `SDTurboScheduler` · 输入: model, steps, denoise · 输出: SIGMAS
- **VPScheduler** — `VPScheduler` · 输入: steps, beta_d, beta_min, eps_s · 输出: SIGMAS

## model/sampling/sigmas (7)

- **ExtendIntermediateSigmas** — `ExtendIntermediateSigmas` · 输入: sigmas, steps, start_at_sigma, end_at_sigma, spacing · 输出: SIGMAS
- **FlipSigmas** — `FlipSigmas` · 输入: sigmas · 输出: SIGMAS
- **ManualSigmas** — `ManualSigmas` · 输入: sigmas · 输出: SIGMAS
- **SamplingPercentToSigma** — `SamplingPercentToSigma` · 输入: model, sampling_percent, return_actual_sigma · 输出: FLOAT
- **SetFirstSigma** — `SetFirstSigma` · 输入: sigmas, sigma · 输出: SIGMAS
- **SplitSigmas** — `SplitSigmas` · 输入: sigmas, step · 输出: SIGMAS, SIGMAS
- **SplitSigmasDenoise** — `SplitSigmasDenoise` · 输入: sigmas, denoise · 输出: SIGMAS, SIGMAS

## model/training (6)

- **Load Training Dataset** — `LoadTrainingDataset` · 输入: folder_name · 输出: LATENT, CONDITIONING
- **Make Training Dataset** — `MakeTrainingDataset` · 输入: images, vae, clip, texts · 输出: LATENT, CONDITIONING
- **Plot Loss Graph** — `LossGraphNode` · 输入: loss, filename_prefix · 输出: 无
- **Resolution Bucket** — `ResolutionBucket` · 输入: latents, conditioning · 输出: LATENT, CONDITIONING
- **Save Training Dataset** — `SaveTrainingDataset` · 输入: latents, conditioning, folder_name, shard_size · 输出: 无
- **Train LoRA** — `TrainLoraNode` · 输入: model, latents, positive, batch_size, grad_accumulation_steps, steps, learning_rate, rank, optimizer, loss_function, seed, training_dtype, lora_dtype, quantized_backward, algorithm, gradient_checkpointing, checkpoint_depth, offloading, existing_lora, bucket_mode, bypass_mode · 输出: LORA_MODEL, LOSS_MAP, INT

## partner/3d/Meshy (8)

- **Meshy: Animate Model** — `MeshyAnimateModelNode` · 输入: rig_task_id, action_id · 输出: STRING, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Image to Model** — `MeshyImageToModelNode` · 输入: model, image, should_remesh, symmetry_mode, should_texture, pose_mode, seed, ultra_mode · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Multi-Image to Model** — `MeshyMultiImageToModelNode` · 输入: model, images, should_remesh, symmetry_mode, should_texture, pose_mode, seed · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Refine Draft Model** — `MeshyRefineNode` · 输入: model, meshy_task_id, enable_pbr, texture_prompt, texture_resolution, texture_image · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Rig Model** — `MeshyRigModelNode` · 输入: meshy_task_id, height_meters, texture_image · 输出: STRING, MESHY_RIGGED_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Text to Model** — `MeshyTextToModelNode` · 输入: model, prompt, style, should_remesh, symmetry_mode, pose_mode, seed, ultra_mode · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Texture Model** — `MeshyTextureNode` · 输入: model, meshy_task_id, enable_original_uv, pbr, text_style_prompt, texture_resolution, image_style · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX
- **Meshy: Texture Model (Multi-View)** — `MeshyTextureMultiViewNode` · 输入: model, meshy_task_id, multiview_images, enable_original_uv, pbr, texture_resolution · 输出: STRING, MESHY_TASK_ID, FILE_3D_GLB, FILE_3D_FBX

## partner/3d/Rodin (7)

- **Rodin 3D Gen-2.5 - Image to 3D** — `Rodin3D_Gen25_Image` · 输入: images, mode, material, geometry_file_format, texture_mode, seed, TAPose, hd_texture, texture_delight, use_original_alpha, addon_highpack, bbox_width, bbox_height, bbox_length, height_cm · 输出: FILE_3D
- **Rodin 3D Gen-2.5 - Text to 3D** — `Rodin3D_Gen25_Text` · 输入: prompt, mode, material, geometry_file_format, texture_mode, seed, TAPose, hd_texture, texture_delight, addon_highpack, bbox_width, bbox_height, bbox_length, height_cm · 输出: FILE_3D
- **Rodin 3D Generate - Detail Generate** — `Rodin3D_Detail` · 输入: Images, Seed, Material_Type, Polygon_count · 输出: STRING, FILE_3D_GLB
- **Rodin 3D Generate - Gen-2 Generate** — `Rodin3D_Gen2` · 输入: Images, TAPose, Seed, Material_Type, Polygon_count · 输出: STRING, FILE_3D_GLB
- **Rodin 3D Generate - Regular Generate** — `Rodin3D_Regular` · 输入: Images, Seed, Material_Type, Polygon_count · 输出: STRING, FILE_3D_GLB
- **Rodin 3D Generate - Sketch Generate** — `Rodin3D_Sketch` · 输入: Images, Seed · 输出: STRING, FILE_3D_GLB
- **Rodin 3D Generate - Smooth Generate** — `Rodin3D_Smooth` · 输入: Images, Seed, Material_Type, Polygon_count · 输出: STRING, FILE_3D_GLB

## partner/3d/Tencent (6)

- **Hunyuan3D: 3D Part** — `Tencent3DPartNode` · 输入: model_3d, seed · 输出: FILE_3D_FBX
- **Hunyuan3D: 3D Texture Edit** — `Tencent3DTextureEditNode` · 输入: model_3d, prompt, seed · 输出: FILE_3D_GLB, FILE_3D_OBJ, IMAGE
- **Hunyuan3D: Image(s) to Model** — `TencentImageToModelNode` · 输入: model, image, face_count, generate_type, seed, image_left, image_right, image_back · 输出: STRING, FILE_3D_GLB, FILE_3D_OBJ, IMAGE, IMAGE, IMAGE, IMAGE
- **Hunyuan3D: Model to UV** — `TencentModelTo3DUVNode` · 输入: model_3d, seed · 输出: FILE_3D_OBJ, FILE_3D_FBX, IMAGE
- **Hunyuan3D: Smart Topology** — `TencentSmartTopologyNode` · 输入: model_3d, polygon_type, face_level, seed · 输出: FILE_3D_OBJ
- **Hunyuan3D: Text to Model** — `TencentTextToModelNode` · 输入: model, prompt, face_count, generate_type, seed · 输出: STRING, FILE_3D_GLB, FILE_3D_OBJ, IMAGE

## partner/3d/Tripo (11)

- **Tripo P1: Image to Model** — `TripoP1ImageToModelNode` · 输入: image, output_mode, enable_image_autofix, face_limit, model_seed, auto_size, export_uv, compress_geometry · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo P1: Multiview to Model** — `TripoP1MultiviewToModelNode` · 输入: image, output_mode, image_left, image_back, image_right, face_limit, model_seed, auto_size, export_uv, compress_geometry · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo P1: Text to Model** — `TripoP1TextToModelNode` · 输入: prompt, output_mode, negative_prompt, image_seed, face_limit, model_seed, auto_size, export_uv, compress_geometry · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo: Convert model** — `TripoConversionNode` · 输入: original_model_task_id, format, quad, face_limit, texture_size, texture_format, force_symmetry, flatten_bottom, flatten_bottom_threshold, pivot_to_center_bottom, scale_factor, with_animation, pack_uv, bake, part_names, fbx_preset, export_vertex_colors, export_orientation, animate_in_place · 输出: 无
- **Tripo: Image to Model** — `TripoImageToModelNode` · 输入: image, model_version, style, texture, pbr, model_seed, orientation, texture_seed, texture_quality, texture_alignment, face_limit, quad, geometry_quality · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo: Import Model** — `TripoImportModelNode` · 输入: model_3d · 输出: MODEL_TASK_ID
- **Tripo: Multiview to Model** — `TripoMultiviewToModelNode` · 输入: image, image_left, image_back, image_right, model_version, orientation, texture, pbr, model_seed, texture_seed, texture_quality, texture_alignment, face_limit, quad, geometry_quality · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo: Retarget rigged model** — `TripoRetargetNode` · 输入: original_model_task_id, animation · 输出: STRING, RETARGET_TASK_ID, FILE_3D_GLB
- **Tripo: Rig model** — `TripoRigNode` · 输入: original_model_task_id · 输出: STRING, RIG_TASK_ID, FILE_3D_GLB
- **Tripo: Text to Model** — `TripoTextToModelNode` · 输入: prompt, negative_prompt, model_version, style, texture, pbr, image_seed, model_seed, texture_seed, texture_quality, face_limit, quad, geometry_quality · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB
- **Tripo: Texture model** — `TripoTextureNode` · 输入: model_task_id, texture, pbr, texture_seed, texture_quality, texture_alignment, texture_prompt · 输出: STRING, MODEL_TASK_ID, FILE_3D_GLB

## partner/audio/ByteDance (1)

- **ByteDance Seed Audio 1.0** — `ByteDanceSeedAudio` · 输入: text_prompt, reference_mode, sample_rate, speech_rate, loudness_rate, pitch_rate, seed, model · 输出: AUDIO

## partner/audio/ElevenLabs (8)

- **ElevenLabs Instant Voice Clone** — `ElevenLabsInstantVoiceClone` · 输入: files, remove_background_noise · 输出: ELEVENLABS_VOICE
- **ElevenLabs Speech to Speech** — `ElevenLabsSpeechToSpeech` · 输入: voice, audio, stability, model, output_format, seed, remove_background_noise · 输出: AUDIO
- **ElevenLabs Speech to Text** — `ElevenLabsSpeechToText` · 输入: audio, model, language_code, num_speakers, seed · 输出: STRING, STRING, STRING
- **ElevenLabs Text to Dialogue** — `ElevenLabsTextToDialogue` · 输入: stability, apply_text_normalization, model, inputs, language_code, seed, output_format · 输出: AUDIO
- **ElevenLabs Text to Sound Effects** — `ElevenLabsTextToSoundEffects` · 输入: text, model, output_format · 输出: AUDIO
- **ElevenLabs Text to Speech** — `ElevenLabsTextToSpeech` · 输入: voice, text, stability, apply_text_normalization, model, language_code, seed, output_format · 输出: AUDIO
- **ElevenLabs Voice Isolation** — `ElevenLabsAudioIsolation` · 输入: audio · 输出: AUDIO
- **ElevenLabs Voice Selector** — `ElevenLabsVoiceSelector` · 输入: voice · 输出: ELEVENLABS_VOICE

## partner/audio/Fish Audio (4)

- **Fish Audio Instant Voice Clone** — `FishAudioInstantVoiceClone` · 输入: files, enhance_audio_quality · 输出: FISHAUDIO_VOICE
- **Fish Audio Speech to Text** — `FishAudioSpeechToText` · 输入: audio, language, precise_timestamps · 输出: STRING, STRING, STRING
- **Fish Audio Text to Speech** — `FishAudioTextToSpeech` · 输入: text, model, seed · 输出: AUDIO
- **Fish Audio Voice Selector** — `FishAudioVoiceSelector` · 输入: voice · 输出: FISHAUDIO_VOICE

## partner/audio/HeyGen (1)

- **HeyGen Text to Speech** — `HeyGenTextToSpeechNode` · 输入: text, voice, custom_voice_id, speed, ssml, seed · 输出: AUDIO

## partner/audio/Sonilo (2)

- **Sonilo Text to Music** — `SoniloTextToMusic` · 输入: prompt, duration, seed · 输出: AUDIO
- **Sonilo Video to Music** — `SoniloVideoToMusic` · 输入: video, prompt, seed · 输出: AUDIO

## partner/image/Beeble (1)

- **Beeble SwitchX Image Edit** — `BeebleSwitchXImageEdit` · 输入: image, prompt, alpha_mode, max_resolution, seed, reference_image · 输出: IMAGE, MASK

## partner/image/BFL (10)

- **Flux 1.1 [pro] Ultra Image** — `FluxProUltraImageNode` · 输入: prompt, prompt_upsampling, seed, aspect_ratio, raw, image_prompt, image_prompt_strength · 输出: IMAGE
- **Flux Erase Image** — `FluxEraseNode` · 输入: image, mask, dilate_pixels, seed · 输出: IMAGE
- **Flux Virtual Try-On** — `FluxVTONode` · 输入: person, garment, prompt, seed · 输出: IMAGE
- **Flux.1 Expand Image** — `FluxProExpandNode` · 输入: image, prompt, prompt_upsampling, top, bottom, left, right, guidance, steps, seed · 输出: IMAGE
- **Flux.1 Fill Image** — `FluxProFillNode` · 输入: image, mask, prompt, prompt_upsampling, guidance, steps, seed · 输出: IMAGE
- **Flux.1 Kontext [max] Image** — `FluxKontextMaxImageNode` · 输入: prompt, aspect_ratio, guidance, steps, seed, prompt_upsampling, input_image · 输出: IMAGE
- **Flux.1 Kontext [pro] Image** — `FluxKontextProImageNode` · 输入: prompt, aspect_ratio, guidance, steps, seed, prompt_upsampling, input_image · 输出: IMAGE
- **Flux.2 [max] Image** — `Flux2MaxImageNode` · 输入: prompt, width, height, seed, prompt_upsampling, images · 输出: IMAGE
- **Flux.2 [pro] Image** — `Flux2ProImageNode` · 输入: prompt, width, height, seed, prompt_upsampling, images · 输出: IMAGE
- **Flux.2 Image** — `Flux2ImageNode` · 输入: prompt, model, seed · 输出: IMAGE

## partner/image/Bria (6)

- **Bria Eraser** — `BriaEraser` · 输入: image, mask, mask_type, moderation · 输出: IMAGE
- **Bria Expand Image** — `BriaExpandImage` · 输入: image, expand_mode, prompt, negative_prompt, seed, moderation · 输出: IMAGE, STRING
- **Bria FIBO Image Edit** — `BriaImageEditNode` · 输入: model, image, prompt, negative_prompt, structured_prompt, seed, guidance_scale, steps, moderation, mask · 输出: IMAGE, STRING
- **Bria Generative Fill** — `BriaGenFill` · 输入: image, mask, prompt, negative_prompt, refine_prompt, seed, moderation · 输出: IMAGE
- **Bria Increase Resolution** — `BriaIncreaseResolution` · 输入: image, desired_increase, auto_downscale, moderation · 输出: IMAGE
- **Bria Remove Image Background** — `BriaRemoveImageBackground` · 输入: image, moderation, seed · 输出: IMAGE

## partner/image/ByteDance (6)

- **ByteDance Create Image Asset** — `ByteDanceCreateImageAsset` · 输入: image, group_id · 输出: STRING, STRING
- **ByteDance Image** — `ByteDanceImageNode` · 输入: model, prompt, size_preset, width, height, seed, guidance_scale, watermark · 输出: IMAGE
- **ByteDance Seedream 4.5 & 5.0** — `ByteDanceSeedreamNode` · 输入: model, prompt, size_preset, image, width, height, sequential_image_generation, max_images, seed, watermark, fail_on_partial · 输出: IMAGE
- **ByteDance Seedream 4.5 & 5.0** — `ByteDanceSeedreamNodeV3` · 输入: prompt, model · 输出: IMAGE
- **ByteDance Seedream 4.5 & 5.0 (Legacy)** — `ByteDanceSeedreamNodeV2` · 输入: prompt, model, seed, watermark, thinking · 输出: IMAGE
- **ByteDance Seedream 5.0 Pro Layer Separation** — `ByteDanceSeedreamLayerSeparationNode` · 输入: image, prompt, size, seed, prompt_optimization, watermark, crop_layers · 输出: IMAGE, MASK, IMAGE, MASK, BOUNDING_BOX, LAYERS

## partner/image/Gemini (4)

- **Nano Banana (Google Gemini Image)** — `GeminiImageNode` · 输入: prompt, model, seed, images, files, aspect_ratio, response_modalities, system_prompt · 输出: IMAGE, STRING
- **Nano Banana 2** — `GeminiNanoBanana2` · 输入: prompt, model, seed, aspect_ratio, resolution, response_modalities, thinking_level, images, files, system_prompt · 输出: IMAGE, STRING, IMAGE
- **Nano Banana 2** — `GeminiNanoBanana2V2` · 输入: prompt, model, seed, response_modalities, system_prompt, temperature, top_p · 输出: IMAGE, STRING, IMAGE
- **Nano Banana Pro (Google Gemini Image)** — `GeminiImage2Node` · 输入: prompt, model, seed, aspect_ratio, resolution, response_modalities, images, files, system_prompt · 输出: IMAGE, STRING

## partner/image/Grok (3)

- **Grok Image** — `GrokImageNode` · 输入: model, prompt, aspect_ratio, number_of_images, seed, resolution, quality · 输出: IMAGE
- **Grok Image Edit** — `GrokImageEditNode` · 输入: model, image, prompt, resolution, number_of_images, seed, aspect_ratio · 输出: IMAGE
- **Grok Image Edit** — `GrokImageEditNodeV2` · 输入: prompt, model, seed · 输出: IMAGE

## partner/image/HitPaw (1)

- **HitPaw General Image Enhance** — `HitPawGeneralImageEnhance` · 输入: model, image, upscale_factor, auto_downscale · 输出: IMAGE

## partner/image/Ideogram (3)

- **Ideogram & Pruna P-Image** — `IdeogramPImage` · 输入: prompt, quality, resolution, aspect_ratio, prompt_upsampling, seed · 输出: IMAGE, STRING
- **Ideogram V3** — `IdeogramV3` · 输入: prompt, image, mask, aspect_ratio, resolution, magic_prompt_option, seed, num_images, rendering_speed, character_image, character_mask · 输出: IMAGE
- **Ideogram V4** — `IdeogramV4` · 输入: prompt, resolution, rendering_speed, seed · 输出: IMAGE

## partner/image/Kling (2)

- **Kling 3.0 Image** — `KlingImageGenerationNode` · 输入: prompt, negative_prompt, image_type, image_fidelity, human_fidelity, model_name, aspect_ratio, n, image, seed · 输出: IMAGE
- **Kling 3.0 Omni Image** — `KlingOmniProImageNode` · 输入: model_name, prompt, resolution, aspect_ratio, series_amount, reference_images, seed · 输出: IMAGE

## partner/image/Krea (2)

- **Krea 2 Image** — `Krea2ImageNode` · 输入: prompt, model, seed · 输出: IMAGE
- **Krea 2 Style Reference** — `Krea2StyleReferenceNode` · 输入: image, strength, style_reference · 输出: KREA_STYLE_REF

## partner/image/Luma (5)

- **Luma Image to Image** — `LumaImageModifyNode` · 输入: image, prompt, image_weight, model, seed · 输出: IMAGE
- **Luma Reference** — `LumaReferenceNode` · 输入: image, weight, luma_ref · 输出: LUMA_REF
- **Luma Text to Image** — `LumaImageNode` · 输入: prompt, model, aspect_ratio, seed, style_image_weight, image_luma_ref, style_image, character_image · 输出: IMAGE
- **Luma UNI-1 Image** — `LumaImageNode2` · 输入: prompt, model, seed · 输出: IMAGE
- **Luma UNI-1 Image Edit** — `LumaImageEditNode2` · 输入: source, prompt, model, seed · 输出: IMAGE

## partner/image/Magnific (5)

- **Magnific Image Relight** — `MagnificImageRelightNode` · 输入: image, prompt, light_transfer_strength, style, interpolate_from_original, change_background, preserve_details, advanced_settings, reference_image · 输出: IMAGE
- **Magnific Image Skin Enhancer** — `MagnificImageSkinEnhancerNode` · 输入: image, sharpen, smart_grain, mode · 输出: IMAGE
- **Magnific Image Style Transfer** — `MagnificImageStyleTransferNode` · 输入: image, reference_image, prompt, style_strength, structure_strength, flavor, engine, portrait_mode, fixed_generation · 输出: IMAGE
- **Magnific Image Upscale (Creative)** — `MagnificImageUpscalerCreativeNode` · 输入: image, prompt, scale_factor, optimized_for, creativity, hdr, resemblance, fractality, engine, auto_downscale · 输出: IMAGE
- **Magnific Image Upscale (Precise V2)** — `MagnificImageUpscalerPreciseV2Node` · 输入: image, scale_factor, flavor, sharpen, smart_grain, ultra_detail, auto_downscale · 输出: IMAGE

## partner/image/OpenAI (4)

- **OpenAI DALL·E 2** — `OpenAIDalle2` · 输入: prompt, seed, size, n, image, mask · 输出: IMAGE
- **OpenAI DALL·E 3** — `OpenAIDalle3` · 输入: prompt, seed, quality, style, size · 输出: IMAGE
- **OpenAI GPT Image 2** — `OpenAIGPTImage1` · 输入: prompt, seed, quality, background, size, n, image, mask, model, custom_width, custom_height · 输出: IMAGE
- **OpenAI GPT Image 2** — `OpenAIGPTImageNodeV2` · 输入: prompt, model, n, seed · 输出: IMAGE

## partner/image/Quiver (2)

- **Quiver Image to SVG** — `QuiverImageToSVGNode` · 输入: image, auto_crop, model, seed · 输出: SVG
- **Quiver Text to SVG** — `QuiverTextToSVGNode` · 输入: prompt, model, seed, instructions, reference_images · 输出: SVG

## partner/image/Qwen (2)

- **Qwen Image 3 Edit** — `QwenImageEditApi` · 输入: model, size, n, seed, prompt_extend, watermark · 输出: IMAGE
- **Qwen Image 3 Text to Image** — `QwenImageTextToImageApi` · 输入: model, n, seed, prompt_extend, watermark · 输出: IMAGE

## partner/image/Recraft (18)

- **Recraft Color RGB** — `RecraftColorRGB` · 输入: r, g, b, recraft_color · 输出: RECRAFT_COLOR
- **Recraft Controls** — `RecraftControls` · 输入: colors, background_color · 输出: RECRAFT_CONTROLS
- **Recraft Create Style** — `RecraftCreateStyleNode` · 输入: style, images · 输出: STRING
- **Recraft Creative Upscale Image** — `RecraftCreativeUpscaleNode` · 输入: image · 输出: IMAGE
- **Recraft Crisp Upscale Image** — `RecraftCrispUpscaleNode` · 输入: image · 输出: IMAGE
- **Recraft Image Inpainting** — `RecraftImageInpaintingNode` · 输入: image, mask, prompt, n, seed, recraft_style, negative_prompt · 输出: IMAGE
- **Recraft Remove Background** — `RecraftRemoveBackgroundNode` · 输入: image · 输出: IMAGE, MASK
- **Recraft Replace Background** — `RecraftReplaceBackgroundNode` · 输入: image, prompt, n, seed, recraft_style, negative_prompt · 输出: IMAGE
- **Recraft Style - Digital Illustration** — `RecraftStyleV3DigitalIllustration` · 输入: substyle · 输出: RECRAFT_V3_STYLE
- **Recraft Style - Infinite Style Library** — `RecraftStyleV3InfiniteStyleLibrary` · 输入: style_id · 输出: RECRAFT_V3_STYLE
- **Recraft Style - Logo Raster** — `RecraftStyleV3LogoRaster` · 输入: substyle · 输出: RECRAFT_V3_STYLE
- **Recraft Style - Realistic Image** — `RecraftStyleV3RealisticImage` · 输入: substyle · 输出: RECRAFT_V3_STYLE
- **Recraft V3 Image to Image** — `RecraftImageToImageNode` · 输入: image, prompt, n, strength, seed, recraft_style, negative_prompt, recraft_controls · 输出: IMAGE
- **Recraft V3 Text to Image** — `RecraftTextToImageNode` · 输入: prompt, size, n, seed, recraft_style, negative_prompt, recraft_controls · 输出: IMAGE
- **Recraft V3 Text to Vector** — `RecraftTextToVectorNode` · 输入: prompt, substyle, size, n, seed, negative_prompt, recraft_controls · 输出: SVG
- **Recraft V4 Text to Image** — `RecraftV4TextToImageNode` · 输入: prompt, negative_prompt, model, n, seed, recraft_controls · 输出: IMAGE
- **Recraft V4 Text to Vector** — `RecraftV4TextToVectorNode` · 输入: prompt, negative_prompt, model, n, seed, recraft_controls · 输出: SVG
- **Recraft Vectorize Image** — `RecraftVectorizeImageNode` · 输入: image · 输出: SVG

## partner/image/Reve (3)

- **Reve Image Create** — `ReveImageCreateNode` · 输入: prompt, model, upscale, remove_background, seed · 输出: IMAGE
- **Reve Image Edit** — `ReveImageEditNode` · 输入: image, edit_instruction, model, upscale, remove_background, seed · 输出: IMAGE
- **Reve Image Remix** — `ReveImageRemixNode` · 输入: reference_images, prompt, model, upscale, remove_background, seed · 输出: IMAGE

## partner/image/Runway (1)

- **Runway Text to Image** — `RunwayTextToImageNode` · 输入: prompt, ratio, reference_image · 输出: IMAGE

## partner/image/Topaz (2)

- **Topaz Image Enhance** — `TopazImageEnhanceV2` · 输入: image, model, output_width, output_height · 输出: IMAGE
- **Topaz Image Enhance (Legacy)** — `TopazImageEnhance` · 输入: model, image, prompt, subject_detection, face_enhancement, face_enhancement_creativity, face_enhancement_strength, crop_to_fill, output_width, output_height, creativity, face_preservation, color_preservation · 输出: IMAGE

## partner/image/Wan (2)

- **Wan Image to Image** — `WanImageToImageApi` · 输入: model, image, prompt, negative_prompt, seed, watermark · 输出: IMAGE
- **Wan Text to Image** — `WanTextToImageApi` · 输入: model, prompt, negative_prompt, width, height, seed, prompt_extend, watermark · 输出: IMAGE

## partner/image/WaveSpeed (1)

- **WaveSpeed Image Upscale** — `WavespeedImageUpscaleNode` · 输入: model, image, target_resolution · 输出: IMAGE

## partner/text/Anthropic (1)

- **Anthropic Claude** — `ClaudeNode` · 输入: prompt, model, seed, images, system_prompt · 输出: STRING

## partner/text/ByteDance (1)

- **ByteDance Seed** — `ByteDanceSeedNode` · 输入: prompt, model, seed, system_prompt · 输出: STRING

## partner/text/Gemini (3)

- **Gemini Input Files** — `GeminiInputFiles` · 输入: file, GEMINI_INPUT_FILES · 输出: GEMINI_INPUT_FILES
- **Google Gemini** — `GeminiNode` · 输入: prompt, model, seed, images, audio, video, files, system_prompt · 输出: STRING
- **Google Gemini** — `GeminiNodeV2` · 输入: prompt, model, seed, system_prompt · 输出: STRING

## partner/text/OpenAI (3)

- **OpenAI ChatGPT** — `OpenAIChatNode` · 输入: prompt, persist_context, model, images, files, advanced_options · 输出: STRING
- **OpenAI ChatGPT Advanced Options** — `OpenAIChatConfig` · 输入: truncation, max_output_tokens, instructions · 输出: OPENAI_CHAT_CONFIG
- **OpenAI ChatGPT Input Files** — `OpenAIInputFiles` · 输入: file, OPENAI_INPUT_FILES · 输出: OPENAI_INPUT_FILES

## partner/text/OpenRouter (1)

- **OpenRouter LLM** — `OpenRouterLLMNode` · 输入: prompt, model, seed, system_prompt · 输出: STRING

## partner/video/Beeble (1)

- **Beeble SwitchX Video Edit** — `BeebleSwitchXVideoEdit` · 输入: video, prompt, alpha_mode, max_resolution, seed, reference_image · 输出: VIDEO, VIDEO

## partner/video/BFL (4)

- **Flux 3 Image to Video** — `Flux3ImageToVideoNode` · 输入: prompt, keyframes, placement, aspect_ratio, duration, resolution, generate_audio, safety_tolerance, seed · 输出: VIDEO
- **Flux 3 Text to Video** — `Flux3TextToVideoNode` · 输入: prompt, aspect_ratio, duration, resolution, generate_audio, safety_tolerance, seed · 输出: VIDEO
- **Flux 3 Video Continuation** — `Flux3VideoContinuationNode` · 输入: video, prompt, aspect_ratio, duration, resolution, generate_audio, safety_tolerance, seed · 输出: VIDEO
- **Flux Video Upscale** — `FluxVideoUpscaleNode` · 输入: video, upscale_factor, mode, prompt, auto_downscale, safety_tolerance, seed · 输出: VIDEO

## partner/video/Bria (4)

- **Bria Remove Video Background** — `BriaRemoveVideoBackground` · 输入: video, background_color, seed · 输出: VIDEO
- **Bria Remove Video Background (Transparent)** — `BriaTransparentVideoBackground` · 输入: video, seed · 输出: IMAGE, MASK
- **Bria Video Green Screen** — `BriaVideoGreenScreen` · 输入: video, green_shade, seed · 输出: VIDEO
- **Bria Video Replace Background** — `BriaVideoReplaceBackground` · 输入: video, seed, background_image, background_video · 输出: VIDEO

## partner/video/ByteDance (10)

- **ByteDance Create Video Asset** — `ByteDanceCreateVideoAsset` · 输入: video, group_id · 输出: STRING, STRING
- **ByteDance First-Last-Frame to Video** — `ByteDanceFirstLastFrameNode` · 输入: model, prompt, first_frame, last_frame, resolution, aspect_ratio, duration, seed, camera_fixed, watermark, generate_audio · 输出: VIDEO
- **ByteDance Image to Video** — `ByteDanceImageToVideoNode` · 输入: model, prompt, image, resolution, aspect_ratio, duration, seed, camera_fixed, watermark, generate_audio · 输出: VIDEO
- **ByteDance Reference Images to Video** — `ByteDanceImageReferenceNode` · 输入: model, prompt, images, resolution, aspect_ratio, duration, seed, watermark · 输出: VIDEO
- **ByteDance Seedance 2.5 First-Last-Frame to Video** — `ByteDance2FirstLastFrameNode` · 输入: model, seed, watermark, first_frame, last_frame, first_frame_asset_id, last_frame_asset_id · 输出: VIDEO
- **ByteDance Seedance 2.5 Reference to Video** — `ByteDance2ReferenceNodeV2` · 输入: model, seed, watermark · 输出: VIDEO
- **ByteDance Seedance 2.5 Reference to Video (Legacy)** — `ByteDance2ReferenceNode` · 输入: model, seed, watermark · 输出: VIDEO
- **ByteDance Seedance 2.5 Text to Video** — `ByteDance2TextToVideoNode` · 输入: model, seed, watermark · 输出: VIDEO
- **ByteDance Text to Video** — `ByteDanceTextToVideoNode` · 输入: model, prompt, resolution, aspect_ratio, duration, seed, camera_fixed, watermark, generate_audio · 输出: VIDEO
- **ByteDance vCube Video Enhance** — `ByteDanceVideoEnhanceNode` · 输入: video, tool_version, resolution, fps, bitrate_level · 输出: VIDEO

## partner/video/Gemini (1)

- **Google Gemini Omni (Video)** — `GeminiVideoOmni` · 输入: model, seed · 输出: VIDEO, STRING

## partner/video/Grok (4)

- **Grok Reference-to-Video** — `GrokVideoReferenceNode` · 输入: prompt, model, seed · 输出: VIDEO
- **Grok Video** — `GrokVideoNode` · 输入: model, prompt, resolution, aspect_ratio, duration, seed, image · 输出: VIDEO
- **Grok Video Edit** — `GrokVideoEditNode` · 输入: model, prompt, video, seed · 输出: VIDEO
- **Grok Video Extend** — `GrokVideoExtendNode` · 输入: prompt, video, model, seed · 输出: VIDEO

## partner/video/HeyGen (4)

- **HeyGen Avatar Video** — `HeyGenAvatarVideoNode` · 输入: engine, speech, custom_avatar_id, resolution, aspect_ratio, background_color, seed · 输出: VIDEO
- **HeyGen Create Avatar** — `HeyGenCreateAvatarNode` · 输入: source · 输出: STRING, IMAGE
- **HeyGen Talking Photo** — `HeyGenTalkingPhotoNode` · 输入: image, speech, resolution, aspect_ratio, expressiveness, seed · 输出: VIDEO
- **HeyGen Video Translate** — `HeyGenVideoTranslateNode` · 输入: video, output_language, mode, translate_audio_only, speaker_count, seed · 输出: VIDEO

## partner/video/HitPaw (1)

- **HitPaw Video Enhance** — `HitPawVideoEnhance` · 输入: model, video · 输出: VIDEO

## partner/video/Kling (17)

- **Kling 2.6 Image(First Frame) to Video with Audio** — `KlingImageToVideoWithAudio` · 输入: model_name, start_frame, prompt, mode, duration, generate_audio · 输出: VIDEO
- **Kling 2.6 Text to Video with Audio** — `KlingTextToVideoWithAudio` · 输入: model_name, prompt, mode, aspect_ratio, duration, generate_audio · 输出: VIDEO
- **Kling 3.0 First-Last-Frame to Video** — `KlingFirstLastFrameNode` · 输入: prompt, duration, first_frame, end_frame, generate_audio, model, seed · 输出: VIDEO
- **Kling 3.0 Omni Edit Video** — `KlingOmniProEditVideoNode` · 输入: model_name, prompt, video, keep_original_sound, reference_images, resolution, seed · 输出: VIDEO
- **Kling 3.0 Omni First-Last-Frame to Video** — `KlingOmniProFirstLastFrameNode` · 输入: model_name, prompt, duration, first_frame, end_frame, reference_images, resolution, storyboards, generate_audio, seed · 输出: VIDEO
- **Kling 3.0 Omni Image to Video** — `KlingOmniProImageToVideoNode` · 输入: model_name, prompt, aspect_ratio, duration, reference_images, resolution, storyboards, generate_audio, seed · 输出: VIDEO
- **Kling 3.0 Omni Text to Video** — `KlingOmniProTextToVideoNode` · 输入: model_name, prompt, aspect_ratio, duration, resolution, storyboards, generate_audio, seed · 输出: VIDEO
- **Kling 3.0 Omni Video to Video** — `KlingOmniProVideoToVideoNode` · 输入: model_name, prompt, aspect_ratio, duration, reference_video, keep_original_sound, reference_images, resolution, seed · 输出: VIDEO
- **Kling 3.0 Video** — `KlingVideoNode` · 输入: multi_shot, generate_audio, model, seed, start_frame · 输出: VIDEO
- **Kling Avatar 2.0** — `KlingAvatarNode` · 输入: image, sound_file, mode, seed, prompt · 输出: VIDEO
- **Kling Image(First Frame) to Video** — `KlingImage2VideoNode` · 输入: start_frame, prompt, negative_prompt, model_name, cfg_scale, mode, aspect_ratio, duration · 输出: VIDEO, STRING, STRING
- **Kling Lip Sync Video with Audio** — `KlingLipSyncAudioToVideoNode` · 输入: video, audio, voice_language · 输出: VIDEO, STRING, STRING
- **Kling Lip Sync Video with Text** — `KlingLipSyncTextToVideoNode` · 输入: video, text, voice, voice_speed · 输出: VIDEO, STRING, STRING
- **Kling Motion Control** — `KlingMotionControl` · 输入: prompt, reference_image, reference_video, keep_original_sound, character_orientation, mode, model · 输出: VIDEO
- **Kling Start-End Frame to Video** — `KlingStartEndFrameNode` · 输入: start_frame, end_frame, prompt, negative_prompt, cfg_scale, aspect_ratio, mode · 输出: VIDEO, STRING, STRING
- **Kling Text to Video** — `KlingTextToVideoNode` · 输入: prompt, negative_prompt, cfg_scale, aspect_ratio, mode · 输出: VIDEO, STRING, STRING
- **Kling Video Extend** — `KlingVideoExtendNode` · 输入: prompt, negative_prompt, cfg_scale, video_id · 输出: VIDEO, STRING, STRING

## partner/video/LTXV (5)

- **LTX 2.5 Audio To Video** — `LtxApi25AudioToVideo` · 输入: audio, model, prompt, seed, image · 输出: VIDEO
- **LTX 2.5 Image To Video** — `LtxApi25ImageToVideo` · 输入: image, model, prompt, seed, last_frame · 输出: VIDEO
- **LTX 2.5 Text To Video** — `LtxApi25TextToVideo` · 输入: model, prompt, seed · 输出: VIDEO
- **LTXV Image To Video** — `LtxvApiImageToVideo` · 输入: image, model, prompt, duration, resolution, fps, generate_audio · 输出: VIDEO
- **LTXV Text To Video** — `LtxvApiTextToVideo` · 输入: model, prompt, duration, resolution, fps, generate_audio · 输出: VIDEO

## partner/video/Luma (10)

- **Luma Concepts** — `LumaConceptsNode` · 输入: concept1, concept2, concept3, concept4, luma_concepts · 输出: LUMA_CONCEPTS
- **Luma Image to Video** — `LumaImageToVideoNode` · 输入: prompt, model, resolution, duration, loop, seed, first_image, last_image, luma_concepts · 输出: VIDEO
- **Luma Ray 3.2 Extend Video** — `LumaRay32ExtendVideoNode` · 输入: source_generation_id, direction, prompt, resolution, seed · 输出: VIDEO, STRING
- **Luma Ray 3.2 Image to Video** — `LumaRay32ImageToVideoNode` · 输入: prompt, resolution, loop, seed, start_frame, end_frame · 输出: VIDEO, STRING
- **Luma Ray 3.2 Keyframe** — `LumaRay32KeyframeNode` · 输入: image, position, keyframes · 输出: LUMA_RAY32_KEYFRAME
- **Luma Ray 3.2 Keyframes to Video** — `LumaRay32KeyframesToVideoNode` · 输入: prompt, resolution, duration, seed, keyframes · 输出: VIDEO, STRING
- **Luma Ray 3.2 Text to Video** — `LumaRay32TextToVideoNode` · 输入: prompt, aspect_ratio, resolution, duration, loop, seed · 输出: VIDEO, STRING
- **Luma Ray 3.2 Video Edit** — `LumaRay32VideoEditNode` · 输入: video, prompt, resolution, strength, seed · 输出: VIDEO, STRING
- **Luma Ray 3.2 Video Reframe** — `LumaRay32VideoReframeNode` · 输入: video, prompt, aspect_ratio, resolution, seed · 输出: VIDEO, STRING
- **Luma Text to Video** — `LumaVideoNode` · 输入: prompt, model, aspect_ratio, resolution, duration, loop, seed, luma_concepts · 输出: VIDEO

## partner/video/MiniMax (8)

- **MiniMax H3 Context IR (Prompt Enhancer)** — `MinimaxHailuo03ContextIRNode` · 输入: model, first_frame, last_frame · 输出: STRING
- **MiniMax H3 First-Last-Frame to Video** — `MinimaxHailuo03FirstLastFrameNode` · 输入: model, first_frame, seed, watermark, last_frame · 输出: VIDEO
- **MiniMax H3 Reference to Video** — `MinimaxHailuo03ReferenceNode` · 输入: model, seed, watermark · 输出: VIDEO
- **MiniMax H3 Regenerate to 2K** — `MinimaxHailuo03RegenerateNode` · 输入: model, video, watermark, first_frame, last_frame · 输出: VIDEO
- **MiniMax H3 Text to Video** — `MinimaxHailuo03TextToVideoNode` · 输入: model, seed, watermark · 输出: VIDEO
- **MiniMax Hailuo 02 Video** — `MinimaxHailuoVideoNode` · 输入: prompt_text, seed, first_frame_image, prompt_optimizer, duration, resolution · 输出: VIDEO
- **MiniMax Image to Video** — `MinimaxImageToVideoNode` · 输入: image, prompt_text, model, seed · 输出: VIDEO
- **MiniMax Text to Video** — `MinimaxTextToVideoNode` · 输入: prompt_text, model, seed · 输出: VIDEO

## partner/video/PixVerse (9)

- **PixVerse Image to Video** — `PixverseImageToVideoNode` · 输入: image, prompt, quality, duration_seconds, motion_mode, seed, negative_prompt, pixverse_template · 输出: VIDEO
- **PixVerse Template** — `PixverseTemplateNode` · 输入: template · 输出: PIXVERSE_TEMPLATE
- **PixVerse Text to Video** — `PixverseTextToVideoNode` · 输入: prompt, aspect_ratio, quality, duration_seconds, motion_mode, seed, negative_prompt, pixverse_template · 输出: VIDEO
- **PixVerse Transition Video** — `PixverseTransitionVideoNode` · 输入: first_frame, last_frame, prompt, quality, duration_seconds, motion_mode, seed, negative_prompt · 输出: VIDEO
- **PixVerse V6 Extend Video** — `PixverseV6ExtendVideoNode` · 输入: video, model · 输出: VIDEO
- **PixVerse V6 First-Last-Frame to Video** — `PixverseV6FirstLastFrameNode` · 输入: first_frame, last_frame, model · 输出: VIDEO
- **PixVerse V6 Fusion (Reference to Video)** — `PixverseV6FusionVideoNode` · 输入: subjects, backgrounds, videos, model · 输出: VIDEO
- **PixVerse V6 Image to Video** — `PixverseV6ImageToVideoNode` · 输入: image, model · 输出: VIDEO
- **PixVerse V6 Text to Video** — `PixverseV6TextToVideoNode` · 输入: model · 输出: VIDEO

## partner/video/Runway (6)

- **Runway Aleph2 Keyframe** — `RunwayAleph2KeyframeNode` · 输入: image, timing, keyframes · 输出: RUNWAY_ALEPH2_KEYFRAME
- **Runway Aleph2 Prompt Image** — `RunwayAleph2PromptImageNode` · 输入: image, position, prompt_images · 输出: RUNWAY_ALEPH2_PROMPT_IMAGE
- **Runway Aleph2 Video to Video** — `RunwayAleph2VideoToVideoNode` · 输入: prompt, video, seed, public_figure_threshold, keyframes, prompt_images · 输出: VIDEO
- **Runway First-Last-Frame to Video** — `RunwayFirstLastFrameNode` · 输入: prompt, start_frame, end_frame, duration, ratio, seed · 输出: VIDEO
- **Runway Image to Video (Gen3a Turbo)** — `RunwayImageToVideoNodeGen3a` · 输入: prompt, start_frame, duration, ratio, seed · 输出: VIDEO
- **Runway Image to Video (Gen4 Turbo)** — `RunwayImageToVideoNodeGen4` · 输入: prompt, start_frame, duration, ratio, seed · 输出: VIDEO

## partner/video/Sora (1)

- **OpenAI Sora - Video (DEPRECATED)** — `OpenAIVideoSora2` · 输入: model, prompt, size, duration, image, seed · 输出: VIDEO

## partner/video/sync.so (2)

- **sync.so Lip Sync** — `SyncLipSyncNode` · 输入: video, audio, seed, model · 输出: VIDEO
- **sync.so Talking Image** — `SyncTalkingImageNode` · 输入: image, audio, prompt, seed, model · 输出: VIDEO

## partner/video/Topaz (2)

- **Topaz Video Enhance** — `TopazVideoEnhanceV2` · 输入: video, upscaler_model, interpolation_model, dynamic_compression_level · 输出: VIDEO
- **Topaz Video Enhance (Legacy)** — `TopazVideoEnhance` · 输入: video, upscaler_enabled, upscaler_model, upscaler_resolution, upscaler_creativity, interpolation_enabled, interpolation_model, interpolation_slowmo, interpolation_frame_rate, interpolation_duplicate, interpolation_duplicate_threshold, dynamic_compression_level · 输出: VIDEO

## partner/video/Veo (3)

- **Google Veo 2 Video Generation** — `VeoVideoGenerationNode` · 输入: prompt, aspect_ratio, negative_prompt, duration_seconds, enhance_prompt, person_generation, seed, image, model · 输出: VIDEO
- **Google Veo 3 First-Last-Frame to Video** — `Veo3FirstLastFrameNode` · 输入: prompt, negative_prompt, resolution, aspect_ratio, duration, seed, first_frame, last_frame, model, generate_audio · 输出: VIDEO
- **Google Veo 3 Video Generation** — `Veo3VideoGenerationNode` · 输入: prompt, aspect_ratio, resolution, negative_prompt, duration_seconds, enhance_prompt, person_generation, seed, image, model, generate_audio · 输出: VIDEO

## partner/video/Vidu (13)

- **Vidu Image To Video Generation** — `ViduImageToVideoNode` · 输入: model, image, prompt, duration, seed, resolution, movement_amplitude · 输出: VIDEO
- **Vidu Multi-Frame Video Generation** — `ViduMultiFrameVideoNode` · 输入: model, start_image, seed, resolution, frames · 输出: VIDEO
- **Vidu Q3 Image-to-Video Generation** — `Vidu3ImageToVideoNode` · 输入: model, image, prompt, seed · 输出: VIDEO
- **Vidu Q3 Start/End Frame-to-Video Generation** — `Vidu3StartEndToVideoNode` · 输入: model, first_frame, end_frame, prompt, seed · 输出: VIDEO
- **Vidu Q3 Text-to-Video Generation** — `Vidu3TextToVideoNode` · 输入: model, prompt, seed · 输出: VIDEO
- **Vidu Reference To Video Generation** — `ViduReferenceVideoNode` · 输入: model, images, prompt, duration, seed, aspect_ratio, resolution, movement_amplitude · 输出: VIDEO
- **Vidu Start End To Video Generation** — `ViduStartEndToVideoNode` · 输入: model, first_frame, end_frame, prompt, duration, seed, resolution, movement_amplitude · 输出: VIDEO
- **Vidu Text To Video Generation** — `ViduTextToVideoNode` · 输入: model, prompt, duration, seed, aspect_ratio, resolution, movement_amplitude · 输出: VIDEO
- **Vidu Video Extension** — `ViduExtendVideoNode` · 输入: model, video, prompt, seed, end_frame · 输出: VIDEO
- **Vidu2 Image-to-Video Generation** — `Vidu2ImageToVideoNode` · 输入: model, image, prompt, duration, seed, resolution, movement_amplitude · 输出: VIDEO
- **Vidu2 Reference-to-Video Generation** — `Vidu2ReferenceVideoNode` · 输入: model, subjects, prompt, audio, duration, seed, aspect_ratio, resolution, movement_amplitude · 输出: VIDEO
- **Vidu2 Start/End Frame-to-Video Generation** — `Vidu2StartEndToVideoNode` · 输入: model, first_frame, end_frame, prompt, duration, seed, resolution, movement_amplitude · 输出: VIDEO
- **Vidu2 Text-to-Video Generation** — `Vidu2TextToVideoNode` · 输入: model, prompt, duration, seed, aspect_ratio, resolution, background_music · 输出: VIDEO

## partner/video/Wan (14)

- **HappyHorse Image to Video** — `HappyHorseImageToVideoApi` · 输入: model, first_frame, seed, watermark · 输出: VIDEO
- **HappyHorse Reference to Video** — `HappyHorseReferenceVideoApi` · 输入: model, seed, watermark · 输出: VIDEO
- **HappyHorse Text to Video** — `HappyHorseTextToVideoApi` · 输入: model, seed, watermark · 输出: VIDEO
- **HappyHorse Video Edit** — `HappyHorseVideoEditApi` · 输入: model, video, seed, watermark · 输出: VIDEO
- **Wan 2.7 Image to Video** — `Wan2ImageToVideoApi` · 输入: model, first_frame, seed, prompt_extend, watermark, last_frame, audio · 输出: VIDEO
- **Wan 2.7 Reference to Video** — `Wan2ReferenceVideoApi` · 输入: model, seed, watermark · 输出: VIDEO
- **Wan 2.7 Text to Video** — `Wan2TextToVideoApi` · 输入: model, seed, prompt_extend, watermark, audio · 输出: VIDEO
- **Wan 2.7 Video Continuation** — `Wan2VideoContinuationApi` · 输入: model, first_clip, seed, prompt_extend, watermark, last_frame · 输出: VIDEO
- **Wan 2.7 Video Edit** — `Wan2VideoEditApi` · 输入: model, video, seed, audio_setting, watermark · 输出: VIDEO
- **Wan 3.0 Image to Video** — `Wan3ImageToVideoApi` · 输入: model, first_frame, seed, watermark, last_frame · 输出: VIDEO
- **Wan 3.0 Reference to Video** — `Wan3ReferenceToVideoApi` · 输入: model, seed, watermark · 输出: VIDEO
- **Wan Image to Video** — `WanImageToVideoApi` · 输入: model, image, prompt, negative_prompt, resolution, duration, audio, seed, generate_audio, prompt_extend, watermark, shot_type · 输出: VIDEO
- **Wan Reference to Video** — `WanReferenceVideoApi` · 输入: model, prompt, negative_prompt, reference_videos, size, duration, seed, shot_type, watermark · 输出: VIDEO
- **Wan Text to Video** — `WanTextToVideoApi` · 输入: model, prompt, negative_prompt, size, duration, audio, seed, generate_audio, prompt_extend, watermark, shot_type · 输出: VIDEO

## partner/video/WaveSpeed (1)

- **FlashVSR Video Upscale** — `WavespeedFlashVSRNode` · 输入: video, target_resolution · 输出: VIDEO

## text (28)

- **Add Text Prefix (DEPRECATED)** — `AddTextPrefix` · 输入: texts, prefix · 输出: STRING
- **Add Text Suffix (DEPRECATED)** — `AddTextSuffix` · 输入: texts, suffix · 输出: STRING
- **Build JSON Prompt (Ideogram)** — `BuildJsonPromptIdeogram` · 输入: element, high_level_description, background, style, aesthetics, lighting, medium, color_palette · 输出: DICT
- **Compare Text** — `StringCompare` · 输入: string_a, string_b, mode, case_sensitive · 输出: BOOLEAN
- **Concatenate Text** — `StringConcatenate` · 输入: string_a, string_b, delimiter · 输出: STRING
- **Contains Text** — `StringContains` · 输入: string, substring, case_sensitive · 输出: BOOLEAN
- **Convert Array to String** — `ConvertArrayToString` · 输入: array, indent · 输出: STRING
- **Convert Dictionary to String** — `ConvertDictionaryToString` · 输入: dictionary, indent · 输出: STRING
- **Convert Text Case** — `CaseConverter` · 输入: string, mode · 输出: STRING
- **Convert Text to Lowercase (DEPRECATED)** — `TextToLowercase` · 输入: texts · 输出: STRING
- **Convert Text to Uppercase (DEPRECATED)** — `TextToUppercase` · 输入: texts · 输出: STRING
- **Draw Text Overlay** — `TextOverlay` · 输入: images, text, font_size, color, position, align, outline · 输出: IMAGE
- **Extract Text** — `RegexExtract` · 输入: string, regex_pattern, mode, case_insensitive, multiline, dotall, group_index · 输出: STRING
- **Extract Text from JSON** — `JsonExtractString` · 输入: json_string, key · 输出: STRING
- **Format Text** — `StringFormat` · 输入: values, f_string · 输出: STRING
- **Generate LTX2 Prompt** — `TextGenerateLTX2Prompt` · 输入: clip, prompt, max_length, sampling_mode, image, video, audio, thinking, use_default_template · 输出: STRING
- **Generate Text** — `TextGenerate` · 输入: clip, prompt, max_length, sampling_mode, image, video, audio, thinking, use_default_template · 输出: STRING
- **Match Text** — `RegexMatch` · 输入: string, regex_pattern, case_insensitive, multiline, dotall · 输出: BOOLEAN
- **Merge Text Lists (DEPRECATED)** — `MergeTextLists` · 输入: texts · 输出: STRING
- **Replace Text** — `StringReplace` · 输入: string, find, replace · 输出: STRING
- **Replace Text (DEPRECATED)** — `ReplaceText` · 输入: texts, find, replace · 输出: STRING
- **Replace Text (Regex)** — `RegexReplace` · 输入: string, regex_pattern, replace, case_insensitive, multiline, dotall, count · 输出: STRING
- **Save Text** — `SaveText` · 输入: text, filename_prefix, format · 输出: STRING
- **Strip Whitespace (DEPRECATED)** — `StripWhitespace` · 输入: texts · 输出: STRING
- **Substring** — `StringSubstring` · 输入: string, start, end · 输出: STRING
- **Text Length** — `StringLength` · 输入: string · 输出: INT
- **Trim Text** — `StringTrim` · 输入: string, mode · 输出: STRING
- **Truncate Text** — `TruncateText` · 输入: texts, max_length · 输出: STRING

## Uncategorized (1)

- **wanBlockSwap** — `wanBlockSwap` · 输入: model · 输出: MODEL

## utilities (11)

- **Color Picker** — `ColorToRGBInt` · 输入: color · 输出: INT, COLOR, FLOAT
- **Convert Number** — `ComfyNumberConvert` · 输入: value · 输出: FLOAT, INT
- **Create Bounding Boxes** — `CreateBoundingBoxes` · 输入: width, height, editor_state, background, bboxes, last_incoming · 输出: IMAGE, BOUNDING_BOX, ARRAY
- **Create List** — `CreateList` · 输入: inputs · 输出: COMFY_MATCHTYPE_V3
- **Curve Editor** — `CurveEditor` · 输入: curve, histogram · 输出: CURVE
- **Custom Combo** — `CustomCombo` · 输入: choice · 输出: STRING, INT
- **Image Histogram** — `ImageHistogram` · 输入: image · 输出: HISTOGRAM, HISTOGRAM, HISTOGRAM, HISTOGRAM, HISTOGRAM
- **Math Expression** — `ComfyMathExpression` · 输入: expression, values · 输出: FLOAT, INT, BOOLEAN
- **Preview as Text** — `PreviewAny` · 输入: source · 输出: STRING
- **Resolution Selector** — `ResolutionSelector` · 输入: aspect_ratio, megapixels, multiple · 输出: INT, INT
- **Seed** — `SeedNode` · 输入: seed · 输出: INT

## utilities/logic (4)

- **And** — `ComfyAndNode` · 输入: values · 输出: BOOLEAN
- **If/Else Switch** — `ComfySwitchNode` · 输入: switch, on_false, on_true · 输出: COMFY_MATCHTYPE_V3
- **Not** — `ComfyNotNode` · 输入: value · 输出: BOOLEAN
- **Or** — `ComfyOrNode` · 输入: values · 输出: BOOLEAN

## utilities/primitive (6)

- **Boolean** — `PrimitiveBoolean` · 输入: value · 输出: BOOLEAN
- **Bounding Box** — `PrimitiveBoundingBox` · 输入: x, y, width, height · 输出: BOUNDING_BOX
- **Float** — `PrimitiveFloat` · 输入: value · 输出: FLOAT
- **Int** — `PrimitiveInt` · 输入: value · 输出: INT
- **Text** — `PrimitiveString` · 输入: value · 输出: STRING
- **Text (Multiline)** — `PrimitiveStringMultiline` · 输入: value · 输出: STRING

## video (10)

- **Create Video** — `CreateVideo` · 输入: images, fps, audio, bit_depth, color_space · 输出: VIDEO
- **Get Video Components** — `GetVideoComponents` · 输入: video · 输出: IMAGE, AUDIO, FLOAT, COMBO, COMBO
- **Load Video** — `LoadVideo` · 输入: file · 输出: VIDEO
- **Load Video (from Folder)** — `LoadVideoDataSetFromFolder` · 输入: folder · 输出: VIDEO
- **Load Video-Text (from Folder)** — `LoadVideoTextDataSetFromFolder` · 输入: folder · 输出: VIDEO, STRING
- **Run Frame Interpolation Model** — `FrameInterpolate` · 输入: interp_model, images, multiplier · 输出: IMAGE
- **Sample Video Frame** — `VideoFrameSample` · 输入: video, num_frames, strategy, seed · 输出: VIDEO
- **Save Video** — `SaveVideo` · 输入: video, filename_prefix, format, codec · 输出: VIDEO
- **Save WEBM** — `SaveWEBM` · 输入: images, filename_prefix, codec, fps, crf · 输出: IMAGE
- **Trim Video** — `Video Slice` · 输入: video, start_time, duration, strict_duration · 输出: VIDEO

## video/batch (1)

- **Shuffle Videos List** — `ShuffleVideoDataset` · 输入: videos, seed · 输出: VIDEO

## video/preprocessors (1)

- **LTXV Preprocess** — `LTXVPreprocess` · 输入: image, img_compression · 输出: IMAGE

## video/transform (2)

- **Crop Video (Temporal Random)** — `VideoRandomTemporalCrop` · 输入: video, length, seed · 输出: VIDEO
- **Crop Video (Temporal)** — `VideoTemporalCrop` · 输入: video, start_frame, length · 输出: VIDEO

