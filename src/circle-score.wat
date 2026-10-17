(module
  (memory (export "memory") 1)
  ;; Three equally sized f64 arrays: x, y, radial tolerance. Length is even.
  (func (export "count") (param $n i32) (param $cx f64) (param $cy f64) (param $r f64) (result i32)
    (local $i i32) (local $bytes i32) (local $count i32)
    (local $dx v128) (local $dy v128) (local $t v128)
    (local $cxv v128) (local $cyv v128) (local $r2 v128) (local $twor v128)
    (local.set $bytes (i32.mul (local.get $n) (i32.const 8)))
    (local.set $cxv (f64x2.splat (local.get $cx)))
    (local.set $cyv (f64x2.splat (local.get $cy)))
    (local.set $r2 (f64x2.splat (f64.mul (local.get $r) (local.get $r))))
    (local.set $twor (f64x2.splat (f64.mul (local.get $r) (f64.const 2))))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $bytes)))
        (local.set $dx (f64x2.sub (v128.load (local.get $i)) (local.get $cxv)))
        (local.set $dy (f64x2.sub (v128.load (i32.add (local.get $i) (local.get $bytes))) (local.get $cyv)))
        (local.set $t (v128.load (i32.add (local.get $i) (i32.mul (local.get $bytes) (i32.const 2)))))
        (local.set $count (i32.add (local.get $count)
          (i32.popcnt (i64x2.bitmask (f64x2.le
            (f64x2.abs (f64x2.sub
              (f64x2.add (f64x2.mul (local.get $dx) (local.get $dx)) (f64x2.mul (local.get $dy) (local.get $dy)))
              (local.get $r2)))
            (f64x2.add (f64x2.mul (local.get $twor) (local.get $t)) (f64x2.mul (local.get $t) (local.get $t))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $next)))
    (local.get $count)))
